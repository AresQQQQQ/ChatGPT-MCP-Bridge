import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { WorkspaceFileError, WorkspaceRegistry } from "../workspaces/workspace-registry.js";

const execFileAsync = promisify(execFile);
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_PDF_BYTES = 50 * 1024 * 1024;
const MAX_RENDERED_IMAGE_BYTES = 20 * 1024 * 1024;
const DEFAULT_PDF_MAX_DIMENSION = 2400;
const MAX_PDF_MAX_DIMENSION = 4096;
const POWERSHELL_TIMEOUT_MS = 30_000;
const MAX_RENDERER_ERROR_CHARS = 1_000;
const MAX_PDF_TEXT_PAGES = 20;
const MAX_PDF_TEXT_BYTES = 2 * 1024 * 1024;

export class MediaToolError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "MediaToolError";
  }
}

export type SupportedImageMimeType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

export interface ImageFileResult {
  readonly workspaceId: string;
  readonly path: string;
  readonly mimeType: SupportedImageMimeType;
  readonly bytes: number;
  readonly data: Buffer;
}

export interface PdfInfoResult {
  readonly workspaceId: string;
  readonly path: string;
  readonly bytes: number;
  readonly pageCount: number;
}

export interface RenderPdfPageOptions {
  readonly page: number;
  readonly maxDimension?: number;
}

export interface RenderedPdfPageResult {
  readonly workspaceId: string;
  readonly path: string;
  readonly page: number;
  readonly pageCount: number;
  readonly width: number;
  readonly height: number;
  readonly mimeType: "image/png";
  readonly bytes: number;
  readonly data: Buffer;
}

export interface ExtractPdfTextOptions {
  readonly startPage?: number;
  readonly endPage?: number;
}

export interface ExtractedPdfTextPage {
  readonly page: number;
  readonly text: string;
}

export interface ExtractedPdfTextResult {
  readonly workspaceId: string;
  readonly path: string;
  readonly pageCount: number;
  readonly startPage: number;
  readonly endPage: number;
  readonly pages: readonly ExtractedPdfTextPage[];
  readonly truncated: boolean;
}

interface PdfProbeResult { readonly pageCount: number }
interface PdfRenderMetadata extends PdfProbeResult { readonly width: number; readonly height: number }

const PDF_PROBE_SCRIPT = String.raw`
param([Parameter(Mandatory=$true)][string]$PdfPath)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
[Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime] > $null
[Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType=WindowsRuntime] > $null
function Await-Result($operation, [Type]$resultType) {
  $method = [System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetGenericArguments().Count -eq 1 -and $_.GetParameters().Count -eq 1 } |
    Select-Object -First 1
  $task = $method.MakeGenericMethod($resultType).Invoke($null, @($operation))
  $task.GetAwaiter().GetResult()
}
$file = Await-Result ([Windows.Storage.StorageFile]::GetFileFromPathAsync($PdfPath)) ([Windows.Storage.StorageFile])
$pdf = Await-Result ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])
@{ pageCount = [int]$pdf.PageCount } | ConvertTo-Json -Compress
`;

const PDF_RENDER_SCRIPT = String.raw`
param(
  [Parameter(Mandatory=$true)][string]$PdfPath,
  [Parameter(Mandatory=$true)][string]$OutputPath,
  [Parameter(Mandatory=$true)][int]$PageIndex,
  [Parameter(Mandatory=$true)][int]$MaxDimension
)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
[Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime] > $null
[Windows.Storage.FileAccessMode, Windows.Storage, ContentType=WindowsRuntime] > $null
[Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType=WindowsRuntime] > $null
[Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType=WindowsRuntime] > $null
[Windows.Data.Pdf.PdfPageRenderOptions, Windows.Data.Pdf, ContentType=WindowsRuntime] > $null
[Windows.Graphics.Imaging.BitmapEncoder, Windows.Graphics.Imaging, ContentType=WindowsRuntime] > $null
function Await-Result($operation, [Type]$resultType) {
  $method = [System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetGenericArguments().Count -eq 1 -and $_.GetParameters().Count -eq 1 } |
    Select-Object -First 1
  $task = $method.MakeGenericMethod($resultType).Invoke($null, @($operation))
  $task.GetAwaiter().GetResult()
}
function Await-Action($operation) {
  $method = [System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object { $_.Name -eq 'AsTask' -and -not $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 } |
    Select-Object -First 1
  $task = $method.Invoke($null, @($operation))
  $null = $task.GetAwaiter().GetResult()
}
$pdfFile = Await-Result ([Windows.Storage.StorageFile]::GetFileFromPathAsync($PdfPath)) ([Windows.Storage.StorageFile])
$pdf = Await-Result ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($pdfFile)) ([Windows.Data.Pdf.PdfDocument])
if ($PageIndex -lt 0 -or $PageIndex -ge [int]$pdf.PageCount) { throw 'PDF page is out of range' }
$page = $pdf.GetPage([uint32]$PageIndex)
try {
  $size = $page.Size
  $sourceWidth = [double]$size.Width
  $sourceHeight = [double]$size.Height
  if ($sourceWidth -le 0 -or $sourceHeight -le 0) { throw 'PDF page has invalid dimensions' }
  $scale = [Math]::Min(1.0 * $MaxDimension / $sourceWidth, 1.0 * $MaxDimension / $sourceHeight)
  $width = [Math]::Max(1, [int][Math]::Round($sourceWidth * $scale))
  $height = [Math]::Max(1, [int][Math]::Round($sourceHeight * $scale))
  $options = New-Object Windows.Data.Pdf.PdfPageRenderOptions
  $options.DestinationWidth = [uint32]$width
  $options.DestinationHeight = [uint32]$height
  $options.BitmapEncoderId = [Windows.Graphics.Imaging.BitmapEncoder]::PngEncoderId
  $fileStream = [System.IO.File]::Open(
    $OutputPath,
    [System.IO.FileMode]::Create,
    [System.IO.FileAccess]::ReadWrite,
    [System.IO.FileShare]::None
  )
  try {
    $stream = [System.IO.WindowsRuntimeStreamExtensions]::AsRandomAccessStream($fileStream)
    try {
      Await-Action ($page.RenderToStreamAsync($stream, $options))
      $null = Await-Result ($stream.FlushAsync()) ([bool])
    } finally {
      if ($null -ne $stream) { $stream.Dispose() }
    }
  } finally {
    $fileStream.Dispose()
  }
  @{ pageCount = [int]$pdf.PageCount; width = $width; height = $height } | ConvertTo-Json -Compress
} finally {
  $page.Dispose()
}
`;

function resolvePowerShell(): string {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (!systemRoot || !path.isAbsolute(systemRoot)) throw new Error("Windows PowerShell is unavailable");
  return path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function detectImageMimeType(data: Buffer): SupportedImageMimeType | undefined {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.length >= 12 && data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (data.length >= 6) {
    const signature = data.subarray(0, 6).toString("ascii");
    if (signature === "GIF87a" || signature === "GIF89a") return "image/gif";
  }
  return undefined;
}

function assertPdf(data: Buffer): void {
  if (data.length < 5 || data.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw new WorkspaceFileError("INVALID_OPERATION");
  }
}

function parseJsonResult<T>(stdout: string): T {
  const lines = stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const candidate = lines.at(-1);
  if (!candidate) throw new Error("PDF renderer produced no metadata");
  return JSON.parse(candidate) as T;
}

function sanitizeRendererError(value: unknown): string {
  const raw = typeof value === "string" ? value : value instanceof Error ? value.message : String(value ?? "");
  const redactedSecrets = raw
    .replace(/\b(api[_-]?key|token|secret|password)\b\s*[:=]\s*[^\s;]+/giu, "$1=[redacted]")
    .replace(/(?:[A-Za-z]:\\|\\\\)[^\r\n\t]*/gu, "[path]")
    .replace(/\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+/gu, "[path]");
  const compact = redactedSecrets.replace(/\s+/gu, " ").trim();
  return (compact || "unknown renderer error").slice(0, MAX_RENDERER_ERROR_CHARS);
}

async function runPowerShell(script: string, args: readonly string[]): Promise<string> {
  if (process.platform !== "win32") throw new MediaToolError("PDF renderer failed: Windows PowerShell is unavailable");
  const directory = await mkdtemp(path.join(os.tmpdir(), "mcp-bridge-pdf-script-"));
  const scriptPath = path.join(directory, "render.ps1");
  try {
    await writeFile(scriptPath, script, { encoding: "utf8", mode: 0o600 });
    try {
      const result = await execFileAsync(
        resolvePowerShell(),
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...args],
        { windowsHide: true, timeout: POWERSHELL_TIMEOUT_MS, maxBuffer: 256 * 1024 },
      );
      return result.stdout;
    } catch (error) {
      const stderr = error && typeof error === "object" && "stderr" in error ? (error as { stderr?: unknown }).stderr : undefined;
      throw new MediaToolError(`PDF renderer failed: ${sanitizeRendererError(stderr ?? error)}`);
    }
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function withTemporaryPdf<T>(data: Buffer, operation: (pdfPath: string, directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mcp-bridge-pdf-"));
  const pdfPath = path.join(directory, "input.pdf");
  try {
    await writeFile(pdfPath, data, { mode: 0o600 });
    return await operation(pdfPath, directory);
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function getImage(registry: WorkspaceRegistry, workspaceId: string, relativePath: string): Promise<ImageFileResult> {
  const file = await registry.readBinaryFile(workspaceId, relativePath, MAX_IMAGE_BYTES);
  const mimeType = detectImageMimeType(file.data);
  if (!mimeType) throw new WorkspaceFileError("INVALID_OPERATION");
  return { workspaceId, path: relativePath, mimeType, bytes: file.bytes, data: file.data };
}

export async function getPdfInfo(registry: WorkspaceRegistry, workspaceId: string, relativePath: string): Promise<PdfInfoResult> {
  const file = await registry.readBinaryFile(workspaceId, relativePath, MAX_PDF_BYTES);
  assertPdf(file.data);
  const metadata = await withTemporaryPdf(file.data, async (pdfPath) =>
    parseJsonResult<PdfProbeResult>(await runPowerShell(PDF_PROBE_SCRIPT, ["-PdfPath", pdfPath])));
  if (!Number.isSafeInteger(metadata.pageCount) || metadata.pageCount < 1) throw new Error("PDF renderer returned invalid page count");
  return { workspaceId, path: relativePath, bytes: file.bytes, pageCount: metadata.pageCount };
}

function truncateUtf8(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.byteLength <= maxBytes) return text;
  let end = Math.max(0, Math.min(maxBytes, buffer.byteLength));
  while (end > 0) {
    const byte = buffer[end];
    if (byte === undefined || (byte & 0xc0) !== 0x80) break;
    end -= 1;
  }
  return buffer.subarray(0, end).toString("utf8");
}

function textContentToString(items: readonly unknown[]): string {
  let result = "";
  for (const item of items) {
    if (!item || typeof item !== "object" || !("str" in item) || typeof item.str !== "string") continue;
    if (result && !result.endsWith("\n") && item.str && !/^\s/u.test(item.str)) result += " ";
    result += item.str;
    if ("hasEOL" in item && item.hasEOL === true) result += "\n";
  }
  return result.trimEnd();
}

export async function extractPdfText(
  registry: WorkspaceRegistry,
  workspaceId: string,
  relativePath: string,
  options: ExtractPdfTextOptions = {},
): Promise<ExtractedPdfTextResult> {
  const file = await registry.readBinaryFile(workspaceId, relativePath, MAX_PDF_BYTES);
  assertPdf(file.data);
  try {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const loadingTask = pdfjs.getDocument({
      data: new Uint8Array(file.data),
      disableFontFace: true,
      useSystemFonts: false,
    });
    try {
      const document = await loadingTask.promise;
      const pageCount = document.numPages;
      if (!Number.isSafeInteger(pageCount) || pageCount < 1) throw new MediaToolError("PDF text extractor failed: invalid page count");
      const startPage = options.startPage ?? 1;
      const requestedEndPage = options.endPage ?? Math.min(pageCount, startPage + MAX_PDF_TEXT_PAGES - 1);
      if (
        !Number.isSafeInteger(startPage) || startPage < 1 || startPage > pageCount ||
        !Number.isSafeInteger(requestedEndPage) || requestedEndPage < startPage || requestedEndPage > pageCount ||
        requestedEndPage - startPage + 1 > MAX_PDF_TEXT_PAGES
      ) throw new WorkspaceFileError("INVALID_OPERATION");

      const pages: ExtractedPdfTextPage[] = [];
      let totalBytes = 0;
      let endPage = startPage - 1;
      let truncated = options.endPage === undefined && requestedEndPage < pageCount;
      for (let pageNumber = startPage; pageNumber <= requestedEndPage; pageNumber += 1) {
        const page = await document.getPage(pageNumber);
        const content = await page.getTextContent();
        const text = textContentToString(content.items);
        const textBytes = Buffer.byteLength(text, "utf8");
        const remainingBytes = MAX_PDF_TEXT_BYTES - totalBytes;
        if (textBytes > remainingBytes) {
          pages.push({ page: pageNumber, text: truncateUtf8(text, remainingBytes) });
          endPage = pageNumber;
          truncated = true;
          break;
        }
        pages.push({ page: pageNumber, text });
        totalBytes += textBytes;
        endPage = pageNumber;
      }
      return { workspaceId, path: relativePath, pageCount, startPage, endPage, pages, truncated };
    } finally {
      await loadingTask.destroy().catch(() => undefined);
    }
  } catch (error) {
    if (error instanceof WorkspaceFileError || error instanceof MediaToolError) throw error;
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND"
    ) {
      throw new MediaToolError("PDF text extractor failed: pdfjs-dist runtime dependency is unavailable");
    }
    throw new MediaToolError(`PDF text extractor failed: ${sanitizeRendererError(error)}`);
  }
}

export async function renderPdfPage(
  registry: WorkspaceRegistry,
  workspaceId: string,
  relativePath: string,
  options: RenderPdfPageOptions,
): Promise<RenderedPdfPageResult> {
  if (!Number.isSafeInteger(options.page) || options.page < 1) throw new WorkspaceFileError("INVALID_OPERATION");
  const maxDimension = options.maxDimension ?? DEFAULT_PDF_MAX_DIMENSION;
  if (!Number.isSafeInteger(maxDimension) || maxDimension < 256 || maxDimension > MAX_PDF_MAX_DIMENSION) {
    throw new WorkspaceFileError("INVALID_OPERATION");
  }
  const file = await registry.readBinaryFile(workspaceId, relativePath, MAX_PDF_BYTES);
  assertPdf(file.data);
  try {
    return await withTemporaryPdf(file.data, async (pdfPath, directory) => {
      const outputPath = path.join(directory, "page.png");
      const metadata = parseJsonResult<PdfRenderMetadata>(await runPowerShell(PDF_RENDER_SCRIPT, [
        "-PdfPath", pdfPath,
        "-OutputPath", outputPath,
        "-PageIndex", String(options.page - 1),
        "-MaxDimension", String(maxDimension),
      ]));
      if (!Number.isSafeInteger(metadata.pageCount) || metadata.pageCount < 1 || options.page > metadata.pageCount) {
        throw new WorkspaceFileError("INVALID_OPERATION");
      }
      if (!Number.isSafeInteger(metadata.width) || metadata.width < 1 || !Number.isSafeInteger(metadata.height) || metadata.height < 1) {
        throw new Error("PDF renderer returned invalid image dimensions");
      }
      const image = await readFile(outputPath);
      if (image.length < 8 || image.length > MAX_RENDERED_IMAGE_BYTES || detectImageMimeType(image) !== "image/png") {
        throw new Error("PDF renderer returned an invalid PNG image");
      }
      return {
        workspaceId,
        path: relativePath,
        page: options.page,
        pageCount: metadata.pageCount,
        width: metadata.width,
        height: metadata.height,
        mimeType: "image/png" as const,
        bytes: image.byteLength,
        data: image,
      };
    });
  } catch (error) {
    if (error instanceof WorkspaceFileError || error instanceof MediaToolError) throw error;
    throw new MediaToolError(`PDF renderer failed: ${sanitizeRendererError(error)}`);
  }
}
