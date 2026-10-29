import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { isTrustedDevMode } from "../config.js";
import type { WorkspaceRegistry } from "../workspaces/workspace-registry.js";
import { SavedSshHostError, SavedSshHostManager } from "./saved-ssh-hosts.js";
import type { TerminalSessionManager } from "./terminal-sessions.js";

const workspaceIdSchema = z.string().min(1).max(128);
const hostIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u);
const hostSchema = z.object({
  workspaceId: z.string(),
  hostId: z.string(),
  host: z.string(),
  username: z.string(),
  port: z.number().int().min(1).max(65535),
});
const viewSchema = hostSchema.extend({ credentialAvailable: z.boolean() });
const sessionSchema = z.object({
  workspaceId: z.string(),
  sessionId: z.string(),
  executable: z.string(),
  pid: z.number().int(),
  state: z.enum(["running", "closing", "exited"]),
  createdAt: z.string(),
  lastAccessAt: z.string(),
  exitCode: z.number().int().nullable(),
});

function result<T extends object>(data: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
    structuredContent: data as Record<string, unknown>,
  };
}

function fail(error: unknown) {
  return {
    isError: true as const,
    content: [{
      type: "text" as const,
      text: error instanceof SavedSshHostError ? error.message : "Saved SSH credential operation failed",
    }],
  };
}

export function registerSavedSshTools(
  server: McpServer,
  registry: WorkspaceRegistry,
  sessions: TerminalSessionManager,
  hosts: SavedSshHostManager,
): void {
  const requireWorkspace = async (workspaceId: string) => {
    const workspace = await registry.openWorkspace(workspaceId);
    if (!isTrustedDevMode(workspace.mode)) throw new SavedSshHostError("Saved SSH access requires trusted-dev workspace mode");
    return workspace;
  };

  server.registerTool("ssh_host_list", {
    title: "List saved SSH devices",
    description: "List configured SSH device aliases, addresses, usernames and whether their credentials are available in the local Windows Credential Manager or macOS Keychain. Does not return passwords or tokens. Only for trusted-dev workspaces.",
    inputSchema: z.object({ workspaceId: workspaceIdSchema }).strict(),
    outputSchema: z.object({ hosts: z.array(viewSchema) }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ workspaceId }) => {
    try {
      await requireWorkspace(workspaceId);
      return result({ hosts: await hosts.list(workspaceId) });
    } catch (error) { return fail(error); }
  });

  server.registerTool("ssh_host_save", {
    title: "Save SSH device and password on this computer",
    description: "Register or update an SSH device alias. Opens a native hidden-password dialog on the Bridge desktop displaying the target account and address. The secret is stored in the local Windows Credential Manager or macOS Keychain and is not returned to MCP. No SSH or host settings are changed.",
    inputSchema: z.object({
      workspaceId: workspaceIdSchema,
      hostId: hostIdSchema,
      host: z.string().min(1).max(253),
      username: z.string().min(1).max(64),
      port: z.number().int().min(1).max(65535).default(22),
    }).strict(),
    outputSchema: z.object({ saved: z.boolean(), host: hostSchema }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, async ({ workspaceId, hostId, host, username, port }) => {
    try {
      await requireWorkspace(workspaceId);
      return result(await hosts.save({ workspaceId, hostId, host, username, port }));
    } catch (error) { return fail(error); }
  });

  server.registerTool("ssh_host_remove", {
    title: "Remove saved SSH device and password",
    description: "Delete a device alias and its password from the local Windows Credential Manager or macOS Keychain. Does not modify remote SSH servers.",
    inputSchema: z.object({ workspaceId: workspaceIdSchema, hostId: hostIdSchema }).strict(),
    outputSchema: z.object({ removed: z.boolean() }),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, async ({ workspaceId, hostId }) => {
    try {
      await requireWorkspace(workspaceId);
      return result(await hosts.remove(workspaceId, hostId));
    } catch (error) { return fail(error); }
  });

  server.registerTool("ssh_start_saved", {
    title: "SSH terminal login using local credentials",
    description: "Start an interactive OpenSSH session using a configured SSH alias. The Bridge checks SSH host keys strictly and retrieves the saved password from the local credential vault when the SSH client displays a password prompt. Password never appears in MCP arguments or results. Use terminal_read/write/close on the returned sessionId to manage the remote shell; verify login output before sending commands.",
    inputSchema: z.object({
      workspaceId: workspaceIdSchema,
      hostId: hostIdSchema,
    }).strict(),
    outputSchema: sessionSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  }, async ({ workspaceId, hostId }) => {
    try {
      const workspace = await requireWorkspace(workspaceId);
      return result(await hosts.connect(workspaceId, workspace.root, hostId, sessions));
    } catch (error) { return fail(error); }
  });
}
