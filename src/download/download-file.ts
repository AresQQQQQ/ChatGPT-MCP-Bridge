import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import { WorkspaceFileError, WorkspaceRegistry } from "../workspaces/workspace-registry.js";

const DEFAULT_MAX_DOWNLOAD_BYTES = 5 * 1024 * 1024 * 1024;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1_000;
const MAX_REDIRECTS = 10;

export class DownloadError extends Error {
  public constructor(
    public readonly code:
      | "INVALID_URL"
      | "PRIVATE_ADDRESS"
      | "TOO_MANY_REDIRECTS"
      | "HTTP_ERROR"
      | "DOWNLOAD_TIMEOUT"
      | "DOWNLOAD_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "DownloadError";
  }
}

export interface DownloadFileOptions {
  readonly workspaceId: string;
  readonly url: string;
  readonly targetPath: string;
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
  /** Internal test seam; MCP callers cannot provide a DNS resolver. */
  readonly lookupHost?: typeof lookup;
}

export interface DownloadFileResult {
  readonly workspaceId: string;
  readonly path: string;
  readonly sourceUrl: string;
  readonly finalUrl: string;
  readonly bytes: number;
  readonly contentHash: string;
  readonly contentType?: string;
}

function isOpenClashFakeIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a = 0, b = 0] = parts;
  return a === 198 && (b === 18 || b === 19);
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a = 0, b = 0] = parts;
  return a === 0 || a === 10 || a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    isOpenClashFakeIpv4(address) ||
    a >= 224;
}

function isPrivateIpv6(address: string): boolean {
  const normalized = address.toLowerCase().split("%", 1)[0] ?? "";
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd") || /^fe[89ab]/u.test(normalized)) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/u.exec(normalized)?.[1];
  return mapped ? isPrivateIpv4(mapped) : false;
}

function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPrivateIpv4(address);
  if (family === 6) return isPrivateIpv6(address);
  return true;
}

function parseDownloadUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new DownloadError("INVALID_URL", "Download URL is invalid");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new DownloadError("INVALID_URL", "Only HTTP and HTTPS download URLs are allowed");
  }
  if (url.username || url.password || !url.hostname) {
    throw new DownloadError("INVALID_URL", "Download URL cannot contain credentials and must include a hostname");
  }
  return url;
}

async function assertPublicHost(url: URL, lookupHost: typeof lookup = lookup): Promise<void> {
  const hostname = url.hostname.replace(/^\[|\]$/gu, "");
  if (hostname.toLowerCase() === "localhost" || hostname.toLowerCase().endsWith(".localhost")) {
    throw new DownloadError("PRIVATE_ADDRESS", "Download URL resolves to a local or private address");
  }
  const literalFamily = isIP(hostname);
  if (literalFamily) {
    if (isPrivateAddress(hostname)) {
      throw new DownloadError("PRIVATE_ADDRESS", "Download URL resolves to a local or private address");
    }
    return;
  }

  const addresses = await lookupHost(hostname, { all: true, verbatim: true }).catch(() => []);
  if (addresses.length === 0) throw new DownloadError("DOWNLOAD_FAILED", "Download hostname could not be resolved");
  if (addresses.some(({ address }) => isPrivateAddress(address) && !isOpenClashFakeIpv4(address))) {
    throw new DownloadError("PRIVATE_ADDRESS", "Download URL resolves to a local or private address");
  }
}

async function *responseChunks(response: Response): AsyncGenerator<Uint8Array> {
  if (!response.body) throw new DownloadError("DOWNLOAD_FAILED", "Download response has no body");
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value.byteLength > 0) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

export async function downloadFile(registry: WorkspaceRegistry, options: DownloadFileOptions): Promise<DownloadFileResult> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > DEFAULT_MAX_DOWNLOAD_BYTES) {
    throw new DownloadError("DOWNLOAD_FAILED", "Download size limit is invalid");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > DEFAULT_DOWNLOAD_TIMEOUT_MS) {
    throw new DownloadError("DOWNLOAD_FAILED", "Download timeout is invalid");
  }

  const sourceUrl = parseDownloadUrl(options.url);
  let current = sourceUrl;
  const signal = AbortSignal.timeout(timeoutMs);

  try {
    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
      await assertPublicHost(current, options.lookupHost);
      const response = await fetch(current, {
        method: "GET",
        redirect: "manual",
        signal,
        headers: {
          "user-agent": "ChatGPT-MCP-Bridge/0.1",
          accept: "*/*",
        },
      });

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        if (redirect === MAX_REDIRECTS) {
          throw new DownloadError("TOO_MANY_REDIRECTS", "Download exceeded the redirect limit");
        }
        const location = response.headers.get("location");
        if (!location) throw new DownloadError("HTTP_ERROR", `Download redirect ${response.status} did not include a Location header`);
        current = parseDownloadUrl(new URL(location, current).toString());
        continue;
      }

      if (!response.ok) {
        await response.body?.cancel();
        throw new DownloadError("HTTP_ERROR", `Download failed with HTTP ${response.status}`);
      }

      const contentLength = response.headers.get("content-length");
      if (contentLength !== null) {
        const declaredBytes = Number(contentLength);
        if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
          await response.body?.cancel();
          throw new WorkspaceFileError("FILE_TOO_LARGE");
        }
      }

      const written = await registry.writeFileStream(
        options.workspaceId,
        options.targetPath,
        responseChunks(response),
        maxBytes,
      );
      return {
        workspaceId: written.workspaceId,
        path: written.path,
        sourceUrl: sourceUrl.toString(),
        finalUrl: current.toString(),
        bytes: written.bytes,
        contentHash: written.contentHash,
        ...(response.headers.get("content-type") ? { contentType: response.headers.get("content-type")! } : {}),
      };
    }
  } catch (error) {
    if (error instanceof DownloadError || error instanceof WorkspaceFileError) throw error;
    if (signal.aborted) throw new DownloadError("DOWNLOAD_TIMEOUT", "Download timed out");
    throw new DownloadError("DOWNLOAD_FAILED", "Download request failed");
  }

  throw new DownloadError("TOO_MANY_REDIRECTS", "Download exceeded the redirect limit");
}
