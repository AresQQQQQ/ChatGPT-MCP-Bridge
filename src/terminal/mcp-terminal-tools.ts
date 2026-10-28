import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { isTrustedDevMode } from "../config.js";
import type { WorkspaceRegistry } from "../workspaces/workspace-registry.js";
import { TerminalSessionError, TerminalSessionManager } from "./terminal-sessions.js";

const workspaceIdSchema = z.string().min(1).max(128);
const sessionIdSchema = z.string().uuid();
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
const readSchema = sessionSchema.extend({
  output: z.string(),
  nextCursor: z.number().int().nonnegative(),
  truncated: z.boolean(),
});

function result<T extends object>(data: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
    structuredContent: data as Record<string, unknown>,
  };
}

function toolError(_error: unknown) {
  const error = _error instanceof TerminalSessionError ? _error.message : "Terminal request failed";
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: error }],
  };
}

export function registerTerminalTools(
  server: McpServer,
  registry: WorkspaceRegistry,
  sessions: TerminalSessionManager,
): void {
  const requireWorkspace = async (workspaceId: string) => {
    const workspace = await registry.openWorkspace(workspaceId);
    if (!isTrustedDevMode(workspace.mode)) throw new TerminalSessionError("Terminal requires trusted-dev workspace mode");
    return workspace;
  };

  server.registerTool("terminal_start", {
    title: "Start interactive Windows terminal",
    description: "Start a long-lived PTY process in a trusted-dev workspace. For SSH use executable ssh.exe and normal argv. The session survives individual MCP requests. Passwords must not be placed in args; use terminal_local_password for SSH password prompts.",
    inputSchema: z.object({
      workspaceId: workspaceIdSchema,
      executable: z.string().min(1).max(4096),
      args: z.array(z.string().max(16 * 1024)).max(128).optional(),
      cwd: z.string().min(1).max(4096).optional(),
      cols: z.number().int().min(20).max(300).optional(),
      rows: z.number().int().min(5).max(100).optional(),
    }).strict(),
    outputSchema: sessionSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  }, async ({ workspaceId, executable, args, cwd, cols, rows }) => {
    try {
      const workspace = await requireWorkspace(workspaceId);
      return result(await sessions.start(workspaceId, workspace.root, {
        executable,
        ...(args ? { args } : {}),
        ...(cwd ? { cwd } : {}),
        ...(cols ? { cols } : {}),
        ...(rows ? { rows } : {}),
      }));
    } catch (error) { return toolError(error); }
  });

  server.registerTool("terminal_list", {
    title: "List interactive terminal sessions",
    description: "List retained PTY sessions for one trusted-dev workspace. Does not expose process command arguments or credentials.",
    inputSchema: z.object({ workspaceId: workspaceIdSchema }).strict(),
    outputSchema: z.object({ sessions: z.array(sessionSchema) }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ workspaceId }) => {
    try {
      await requireWorkspace(workspaceId);
      return result({ sessions: sessions.list(workspaceId) });
    } catch (error) { return toolError(error); }
  });

  server.registerTool("terminal_read", {
    title: "Read interactive terminal output",
    description: "Read PTY output using a cursor; can wait for new output up to 5 seconds. nextCursor is the position after returned output; truncated means older output was evicted.",
    inputSchema: z.object({
      workspaceId: workspaceIdSchema,
      sessionId: sessionIdSchema,
      cursor: z.number().int().nonnegative().optional(),
      waitMs: z.number().int().min(0).max(5000).optional(),
    }).strict(),
    outputSchema: readSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ workspaceId, sessionId, cursor, waitMs }, extra) => {
    try {
      await requireWorkspace(workspaceId);
      return result(await sessions.read(workspaceId, sessionId, cursor, waitMs, extra.signal));
    } catch (error) { return toolError(error); }
  });

  server.registerTool("terminal_write", {
    title: "Send interactive terminal input",
    description: "Write normal terminal keystrokes or commands to an existing PTY. Do not send secrets or passwords in this tool: arguments can be visible to the MCP client and logs. For SSH passwords use terminal_local_password.",
    inputSchema: z.object({
      workspaceId: workspaceIdSchema,
      sessionId: sessionIdSchema,
      input: z.string().min(1).max(4096),
    }).strict(),
    outputSchema: z.object({ written: z.literal(true) }),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  }, async ({ workspaceId, sessionId, input }) => {
    try {
      await requireWorkspace(workspaceId);
      return result(sessions.write(workspaceId, sessionId, input));
    } catch (error) { return toolError(error); }
  });

  server.registerTool("terminal_local_password", {
    title: "Enter SSH password locally on Windows",
    description: "Only for a running ssh.exe PTY displaying a recent password/passphrase prompt. Opens a PasswordBox window on the Windows Bridge desktop. The user types locally: the secret is written directly to the SSH process, never returned to MCP or logged. Works only with an interactive Windows desktop.",
    inputSchema: z.object({
      workspaceId: workspaceIdSchema,
      sessionId: sessionIdSchema,
    }).strict(),
    outputSchema: z.object({ submitted: z.boolean() }),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  }, async ({ workspaceId, sessionId }) => {
    try {
      await requireWorkspace(workspaceId);
      return result(await sessions.localPassword(workspaceId, sessionId));
    } catch (error) { return toolError(error); }
  });

  server.registerTool("terminal_close", {
    title: "Close interactive terminal",
    description: "Terminate an owned PTY session and its running process. Returned final output can be read until the session expires.",
    inputSchema: z.object({
      workspaceId: workspaceIdSchema,
      sessionId: sessionIdSchema,
    }).strict(),
    outputSchema: sessionSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, async ({ workspaceId, sessionId }) => {
    try {
      await requireWorkspace(workspaceId);
      return result(sessions.closeSession(workspaceId, sessionId));
    } catch (error) { return toolError(error); }
  });
}
