import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { DownloadError, downloadFile } from "../src/download/download-file.js";
import { WorkspaceRegistry } from "../src/workspaces/workspace-registry.js";

async function temporaryRegistry(): Promise<{ root: string; registry: WorkspaceRegistry }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-bridge-download-"));
  const registry = await WorkspaceRegistry.create({
    workspaces: [{ id: "demo", root, mode: "workspace" }],
    maxReadBytes: 1024 * 1024,
  });
  return { root, registry };
}

test("downloadFile streams a public URL into an exact workspace path without overwrite", async () => {
  const { root, registry } = await temporaryRegistry();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(Buffer.from([0, 1, 2, 3, 255]), {
    status: 200,
    headers: { "content-type": "application/octet-stream", "content-length": "5" },
  })) as typeof fetch;
  try {
    const result = await downloadFile(registry, {
      workspaceId: "demo",
      url: "https://93.184.216.34/example.bin",
      targetPath: "example.bin",
    });
    assert.equal(result.bytes, 5);
    assert.equal(result.contentType, "application/octet-stream");
    assert.match(result.contentHash, /^[0-9a-f]{64}$/u);
    assert.deepEqual(await readFile(path.join(root, "example.bin")), Buffer.from([0, 1, 2, 3, 255]));

    await assert.rejects(
      downloadFile(registry, {
        workspaceId: "demo",
        url: "https://93.184.216.34/example.bin",
        targetPath: "example.bin",
      }),
      /already exists/u,
    );
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("downloadFile allows OpenClash Fake-IP only when it came from hostname resolution", async () => {
  const { root, registry } = await temporaryRegistry();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(Buffer.from("fake-ip-ok"), { status: 200 })) as typeof fetch;
  try {
    const result = await downloadFile(registry, {
      workspaceId: "demo",
      url: "https://github.example/file.bin",
      targetPath: "fake-ip.bin",
      lookupHost: (async () => [{ address: "198.18.12.34", family: 4 }]) as never,
    });
    assert.equal(result.bytes, Buffer.byteLength("fake-ip-ok"));
    await assert.rejects(
      downloadFile(registry, {
        workspaceId: "demo",
        url: "http://198.18.12.34/direct.bin",
        targetPath: "direct.bin",
      }),
      (error: unknown) => error instanceof DownloadError && error.code === "PRIVATE_ADDRESS",
    );
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("downloadFile accepts up to ten redirects and rejects the eleventh", async () => {
  const { root, registry } = await temporaryRegistry();
  const originalFetch = globalThis.fetch;
  let redirectCount = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
    const current = Number(url.searchParams.get("n") ?? "0");
    if (current < 10) {
      redirectCount += 1;
      return new Response(null, { status: 302, headers: { location: `https://93.184.216.34/file?n=${current + 1}` } });
    }
    return new Response(Buffer.from("done"), { status: 200 });
  }) as typeof fetch;
  try {
    const ok = await downloadFile(registry, {
      workspaceId: "demo",
      url: "https://93.184.216.34/file?n=0",
      targetPath: "ten.bin",
    });
    assert.equal(ok.bytes, 4);
    assert.equal(redirectCount, 10);

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      const current = Number(url.searchParams.get("n") ?? "0");
      return new Response(null, { status: 302, headers: { location: `https://93.184.216.34/file?n=${current + 1}` } });
    }) as typeof fetch;
    await assert.rejects(
      downloadFile(registry, {
        workspaceId: "demo",
        url: "https://93.184.216.34/file?n=0",
        targetPath: "eleven.bin",
      }),
      (error: unknown) => error instanceof DownloadError && error.code === "TOO_MANY_REDIRECTS",
    );
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("downloadFile rejects local/private URLs and private redirect targets", async () => {
  const { root, registry } = await temporaryRegistry();
  const originalFetch = globalThis.fetch;
  try {
    await assert.rejects(
      downloadFile(registry, {
        workspaceId: "demo",
        url: "http://127.0.0.1/private.bin",
        targetPath: "private.bin",
      }),
      (error: unknown) => error instanceof DownloadError && error.code === "PRIVATE_ADDRESS",
    );

    globalThis.fetch = (async () => new Response(null, {
      status: 302,
      headers: { location: "http://192.168.1.1/internal.bin" },
    })) as typeof fetch;
    await assert.rejects(
      downloadFile(registry, {
        workspaceId: "demo",
        url: "https://93.184.216.34/start.bin",
        targetPath: "redirect.bin",
      }),
      (error: unknown) => error instanceof DownloadError && error.code === "PRIVATE_ADDRESS",
    );
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("downloadFile enforces the bounded streamed size and leaves no target on failure", async () => {
  const { root, registry } = await temporaryRegistry();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(Buffer.alloc(32), { status: 200 })) as typeof fetch;
  try {
    await assert.rejects(
      downloadFile(registry, {
        workspaceId: "demo",
        url: "https://93.184.216.34/large.bin",
        targetPath: "large.bin",
        maxBytes: 8,
      }),
      /configured read limit|exceeds|too large/i,
    );
    await assert.rejects(readFile(path.join(root, "large.bin")));
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});
