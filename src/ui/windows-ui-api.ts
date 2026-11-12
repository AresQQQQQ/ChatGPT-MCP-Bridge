import { randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";

import { connectionSetupInputSchema, connectionSettingsInputSchema, type ConnectionSetupInput, type ConnectionSettingsInput } from "./connection-setup.js";

export interface WindowsUiApi {
  readonly origin: string;
  readonly token: string;
  close(): Promise<void>;
}

function authorized(token: string, value: string | undefined): boolean {
  if (!value || !value.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(value.slice(7));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

async function jsonInput(req: http.IncomingMessage): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/iu.test(req.headers["content-type"] ?? "")) throw new Error("JSON body required");
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += data.length;
    if (bytes > 8192) throw new Error("Request too large");
    chunks.push(data);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
  catch { throw new Error("Invalid JSON body"); }
}

/** Authenticated in-memory channel for WPF connection settings. */
export async function launchWindowsUiApi(options: {
  onConnectionSetup?: (input: ConnectionSetupInput, progress: (message: string) => void) => Promise<void>;
  onConnectionSettings?: (input: ConnectionSettingsInput, progress: (message: string) => void) => Promise<void>;
} = {}): Promise<WindowsUiApi> {
  if (process.platform !== "win32") throw new Error("Windows Bridge UI requires Windows");
  const token = randomBytes(32).toString("hex");
  let origin = "";

  const server = http.createServer((req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'");
    const send = (status: number, data: unknown): void => {
      if (res.writableEnded || res.destroyed) return;
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(data));
    };
    void (async () => {
      if (req.socket.remoteAddress !== "127.0.0.1" || req.headers.host !== new URL(origin).host ||
          (req.headers.origin !== undefined && req.headers.origin !== origin)) {
        send(403, { error: "Invalid local UI request" }); return;
      }
      if (!authorized(token, req.headers.authorization)) {
        send(401, { error: "Unauthorized" }); return;
      }
      const url = new URL(req.url ?? "/", origin);
      if (req.method === "POST" && url.pathname === "/api/connection/setup") {
        const payload = connectionSetupInputSchema.safeParse(await jsonInput(req));
        if (!payload.success) { send(400, { error: "请检查 Tunnel ID 和 Runtime API key。" }); return; }
        if (!options.onConnectionSetup) { send(503, { error: "连接向导服务不可用。" }); return; }
        try {
          await options.onConnectionSetup(payload.data, () => undefined);
          send(200, { ok: true });
        } catch (error) {
          const raw = error instanceof Error ? error.message : "连接初始化失败。";
          const key = payload.data.runtimeKey ?? "";
          send(400, { error: key ? raw.split(key).join("[已隐藏]") : raw });
        }
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/connection/settings") {
        const payload = connectionSettingsInputSchema.safeParse(await jsonInput(req));
        if (!payload.success) { send(400, { error: "请检查 Runtime API key、Tunnel ID 和端口设置。" }); return; }
        if (!options.onConnectionSettings) { send(503, { error: "连接设置服务不可用。" }); return; }
        try {
          await options.onConnectionSettings(payload.data, () => undefined);
          send(200, { ok: true });
        } catch (error) {
          const raw = error instanceof Error ? error.message : "保存连接设置失败。";
          const key = payload.data.runtimeKey ?? "";
          send(400, { error: key ? raw.split(key).join("[已隐藏]") : raw });
        }
        return;
      }
      send(404, { error: "Not found" });
    })().catch(() => send(500, { error: "Local UI request failed" }));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Invalid local UI address");
    origin = `http://127.0.0.1:${address.port}`;
  } catch (error) {
    server.close();
    throw error;
  }
  return {
    origin, token,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    }),
  };
}
