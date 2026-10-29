import { randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";
import path from "node:path";
import { z } from "zod";

import { isTrustedDevMode } from "../config.js";
import { SavedSshHostError, SavedSshHostManager, type SavedSshHostView, type GlobalUiSaveSshHostRequest } from "../terminal/saved-ssh-hosts.js";
import { readWorkspaceConfig } from "./workspace-config.js";

const alias = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u);
const saveSchema = z.object({
  hostId: alias,
  previousHostId: alias.optional(),
  host: z.string().min(1).max(253),
  username: z.string().min(1).max(64),
  port: z.number().int().min(1).max(65535),
  password: z.string().min(1).max(1200).optional(),
}).strict();
const removeSchema = z.object({ hostId: alias }).strict();

type HostManager = Pick<SavedSshHostManager, "listGlobal" | "saveGlobalFromUi" | "removeGlobal">;

export interface SshUiApi {
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

/** Local-only WPF credentials channel. Passwords travel in memory over loopback, never via command files. */
export async function launchWindowsSshUiApi(
  configPath: string,
  options: { manager?: HostManager } = {},
): Promise<SshUiApi> {
  if (process.platform !== "win32") throw new Error("SSH password management requires Windows Credential Manager");
  const manager = options.manager ?? new SavedSshHostManager(path.join(path.dirname(path.resolve(configPath)), ".mcp-bridge-state", "ssh-hosts.json"));
  const token = randomBytes(32).toString("hex");
  let origin = "";

  async function requireTrustedDevAvailable(): Promise<void> {
    const config = await readWorkspaceConfig(configPath);
    if (!config.workspaces.some(item => isTrustedDevMode(item.mode))) {
      throw new SavedSshHostError("SSH host management requires at least one trusted-dev workspace");
    }
  }

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
        send(403, { error: "Invalid local SSH UI request" }); return;
      }
      if (!authorized(token, req.headers.authorization)) {
        send(401, { error: "Unauthorized" }); return;
      }
      const url = new URL(req.url ?? "/", origin);
      if (req.method === "GET" && url.pathname === "/api/ssh/hosts") {
        await requireTrustedDevAvailable();
        const hosts: SavedSshHostView[] = await manager.listGlobal();
        send(200, { hosts }); return;
      }
      if (req.method === "POST" && url.pathname === "/api/ssh/save") {
        const payload = saveSchema.safeParse(await jsonInput(req));
        if (!payload.success) { send(400, { error: "Invalid SSH host fields" }); return; }
        await requireTrustedDevAvailable();
        const host = await manager.saveGlobalFromUi(payload.data as GlobalUiSaveSshHostRequest);
        send(200, { host, saved: true }); return;
      }
      if (req.method === "POST" && url.pathname === "/api/ssh/remove") {
        const payload = removeSchema.safeParse(await jsonInput(req));
        if (!payload.success) { send(400, { error: "Invalid SSH host alias" }); return; }
        await requireTrustedDevAvailable();
        send(200, await manager.removeGlobal(payload.data.hostId)); return;
      }
      send(404, { error: "Not found" });
    })().catch(error => {
      const message = error instanceof SavedSshHostError ? error.message : "SSH host operation failed";
      const code = error instanceof SavedSshHostError ? 400 : 500;
      send(code, { error: message });
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Invalid local SSH UI address");
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
