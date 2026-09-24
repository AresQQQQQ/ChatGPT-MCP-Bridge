import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  BRIDGE_CAPABILITIES,
  CODEX_DEFAULT_MODEL,
  CODEX_DEFAULT_REASONING_EFFORT,
} from "../capabilities.js";
import { ControlledCommandRunner } from "../commands/command-runner.js";
import { DesktopAppLauncher } from "../commands/desktop-launcher.js";
import { TrustedDevCommandRunner } from "../commands/dev-execution.js";
import { ProcessInspector } from "../commands/process-inspection.js";
import { RecipeRunner } from "../commands/recipe-runner.js";
import { isTrustedDevMode, isWorkspaceWritableMode, type BridgeConfig } from "../config.js";
import { CommandPolicyError } from "../commands/types.js";
import { CodexBridgeError } from "../codex/codex-client.js";
import { type CodexTaskManager, type CodexTaskRecord } from "../codex/codex-tasks.js";
import { DownloadError, downloadFile } from "../download/download-file.js";
import { gitAdd, gitCommit, gitDiff, gitInit, gitLog, gitShow, gitStatus, type GitOperationResult } from "../git/git-operations.js";
import { WorktreeCheckpointStore } from "../git/worktree-checkpoint.js";
import { extractPdfText, getImage, getPdfInfo, MediaToolError, renderPdfPage } from "../media/media-tools.js";
import { callLocalMcpTool, listLocalMcpTools, LocalMcpProxyError } from "./local-mcp-proxy.js";
import { LocalMcpRegistry, LocalMcpRegistryError } from "./local-mcp-registry.js";
import { PathSecurityError } from "../security/path-sandbox.js";
import {
  PatchApplicationError,
  MAX_DIRECTORY_ENTRIES,
  WorkspaceFileError,
  WorkspaceNotFoundError,
  WorkspaceRegistry,
  WorkspaceUnavailableError,
} from "../workspaces/workspace-registry.js";

const workspaceIdSchema = z.string().min(1).max(128);
const relativePathSchema = z.string().min(1).max(4096);
const workspaceRecipeIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u);
const exactPatchSchema = z.object({
  hunks: z.array(z.object({ oldText: z.string().min(1), newText: z.string() }).strict()).min(1).max(100),
}).strict();
const packageScriptNamePattern = "^[A-Za-z0-9][A-Za-z0-9:._/-]{0,63}$";
const packageScriptNameSchema = z.string().regex(new RegExp(packageScriptNamePattern));
const mcpExecKinds = ["test", "build", "lint", "typecheck", "package-script"] as const;
const mcpExecWorkspaceIdJsonSchema = { type: "string", minLength: 1, maxLength: 128 } as const;
const mcpExecCwdJsonSchema = { type: "string", minLength: 1, maxLength: 4096 } as const;
const mcpExecInputJsonSchema = {
  oneOf: [
    ...mcpExecKinds.slice(0, 4).map((kind) => ({
      type: "object",
      properties: {
        workspaceId: mcpExecWorkspaceIdJsonSchema,
        kind: { const: kind },
        cwd: mcpExecCwdJsonSchema,
      },
      required: ["workspaceId", "kind"],
      additionalProperties: false,
    })),
    {
      type: "object",
      properties: {
        workspaceId: mcpExecWorkspaceIdJsonSchema,
        kind: { const: "package-script" },
        name: { type: "string", pattern: packageScriptNamePattern },
        cwd: mcpExecCwdJsonSchema,
      },
      required: ["workspaceId", "kind", "name"],
      additionalProperties: false,
    },
  ],
  discriminator: { propertyName: "kind" },
} as const;
// The SDK currently renders a top-level Zod union as an empty inputSchema in
// tools/list. Keep object-shaped validation for the SDK, and attach the
// explicit JSON Schema union that clients need for argument generation.
const mcpExecRequestSchema = z.object({
  workspaceId: workspaceIdSchema,
  kind: z.enum(mcpExecKinds),
  name: packageScriptNameSchema.optional(),
  cwd: relativePathSchema.optional(),
}).strict().superRefine((input, context) => {
  if (input.kind === "package-script" && input.name === undefined) {
    context.addIssue({ code: "custom", path: ["name"], message: "name is required for package-script" });
  }
  if (input.kind !== "package-script" && input.name !== undefined) {
    context.addIssue({ code: "custom", path: ["name"], message: "name is not accepted for this command kind" });
  }
}).meta(mcpExecInputJsonSchema);

const trustedDevRequestSchema = z.object({
  workspaceId: workspaceIdSchema,
  type: z.enum(["exec", "shell"]),
  executable: z.string().min(1).max(4096).optional(),
  args: z.array(z.string().max(16 * 1024)).max(256).optional(),
  shell: z.enum(["cmd", "powershell"]).optional(),
  command: z.string().min(1).max(128 * 1024).optional(),
  cwd: relativePathSchema.optional(),
  timeoutMs: z.number().int().min(1).max(10 * 60 * 1_000).optional(),
}).strict().superRefine((input, context) => {
  if (input.type === "exec") {
    if (!input.executable) context.addIssue({ code: "custom", path: ["executable"], message: "executable is required for exec" });
    if (input.shell !== undefined || input.command !== undefined) {
      context.addIssue({ code: "custom", path: ["type"], message: "shell and command are not accepted for exec" });
    }
  } else {
    if (!input.shell) context.addIssue({ code: "custom", path: ["shell"], message: "shell is required for shell" });
    if (!input.command) context.addIssue({ code: "custom", path: ["command"], message: "command is required for shell" });
    if (input.executable !== undefined || input.args !== undefined) {
      context.addIssue({ code: "custom", path: ["type"], message: "executable and args are not accepted for shell" });
    }
  }
});
const workspaceContextSchema = z.object({
  path: z.enum(["AGENTS.md", "CLAUDE.md"]),
  content: z.string(),
  bytes: z.number().int().nonnegative(),
});
const writeResultSchema = z.object({ workspaceId: z.string(), path: z.string(), bytes: z.number().int().nonnegative() });
const readFileResultSchema = z.object({
  workspaceId: z.string(),
  path: z.string(),
  content: z.string(),
  bytes: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative().optional(),
  nextOffset: z.number().int().nonnegative().optional(),
  totalBytes: z.number().int().nonnegative().optional(),
  eof: z.boolean().optional(),
});
const searchResultSchema = z.object({
  path: z.string(),
  kind: z.enum(["file", "directory"]),
  match: z.enum(["name", "content", "name-and-content"]),
  line: z.number().int().positive().optional(),
  preview: z.string().max(500).optional(),
});
const paginationSchema = {
  truncated: z.boolean(),
  nextCursor: z.string().optional(),
};
const codexReasoningEffortSchema = z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
const codexModelSchema = z.string().regex(/^[^\s\u0000-\u001f\u007f]{1,256}$/u);
const codexTaskSchema = z.object({
  taskId: z.string(),
  requestId: z.string().optional(),
  workspaceId: z.string(),
  moduleId: z.string(),
  threadId: z.string().optional(),
  turnId: z.string().optional(),
  status: z.enum(["queued", "running", "completed", "failed", "cancelled"]),
  instruction: z.string(),
  model: z.string().optional(),
  effort: codexReasoningEffortSchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  error: z.string().optional(),
  finalResponse: z.string().optional(),
});
const codexModuleSchema = z.object({
  workspaceId: z.string(),
  moduleId: z.string(),
  displayName: z.string(),
  moduleKind: z.enum(["configured", "temporary"]),
  threadId: z.string().optional(),
  bindingStatus: z.enum(["bound", "unbound"]),
  threadName: z.string().optional(),
  archived: z.boolean().optional(),
  ownerPresent: z.boolean().optional(),
});
const codexModuleDeleteSchema = z.object({
  workspaceId: z.string(),
  moduleId: z.string(),
  deleted: z.literal(true),
  unboundThreadId: z.string().optional(),
});
const codexModuleIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u);
const codexModuleDisplayNameSchema = z.string().trim().min(1).max(128);
const codexOpaqueSchema = z.object({ data: z.unknown() });
const gitResultSchema = z.object({
  operation: z.enum(["status", "diff", "log", "show", "init", "add", "commit"]),
  outcome: z.enum(["completed", "failed", "rejected", "timed-out", "output-limit", "aborted"]),
  exitCode: z.number().int().nullable(),
  durationMs: z.number().int().nonnegative(),
  stdoutBytes: z.number().int().nonnegative(),
  stderrBytes: z.number().int().nonnegative(),
  stdout: z.string(),
  stderr: z.string(),
  truncated: z.boolean(),
  reconciliation: z.object({
    status: z.enum(["confirmed-completed", "confirmed-not-completed", "indeterminate"]),
    originalOutcome: z.enum(["completed", "failed", "rejected", "timed-out", "output-limit", "aborted"]),
    beforeHead: z.string().optional(),
    afterHead: z.string().optional(),
  }).optional(),
  indexLock: z.object({
    preExisting: z.boolean(),
    presentAfter: z.boolean(),
  }).optional(),
});

function errorText(error: unknown): string {
  if (error instanceof PathSecurityError) return `Request denied: ${error.code}`;
  if (
    error instanceof WorkspaceNotFoundError ||
    error instanceof WorkspaceUnavailableError ||
    error instanceof WorkspaceFileError ||
    error instanceof PatchApplicationError ||
    error instanceof CommandPolicyError ||
    error instanceof MediaToolError ||
    error instanceof DownloadError ||
    error instanceof CodexBridgeError ||
    error instanceof LocalMcpProxyError ||
    error instanceof LocalMcpRegistryError
  ) return error.message;
  return "Request failed";
}

function toolError(error: unknown) {
  return { isError: true as const, content: [{ type: "text" as const, text: errorText(error) }] };
}

function codexTaskResult(task: CodexTaskRecord) {
  const structuredContent = { ...task };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

function codexModuleResult(module: Awaited<ReturnType<CodexTaskManager["createConfiguredModule"]>>) {
  const structuredContent = { ...module };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

function gitResult(result: GitOperationResult) {
  const structuredContent = {
    operation: result.operation,
    outcome: result.outcome,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    stdoutBytes: result.stdoutBytes,
    stderrBytes: result.stderrBytes,
    stdout: result.stdout,
    stderr: result.stderr,
    truncated: result.truncated,
    ...(result.reconciliation ? { reconciliation: result.reconciliation } : {}),
    ...(result.indexLock ? { indexLock: result.indexLock } : {}),
  };
  const text = [
    result.stdout ? `stdout:\n${result.stdout}` : "",
    result.stderr ? `stderr:\n${result.stderr}` : "",
  ].filter(Boolean).join("\n") || `${result.operation} produced no output`;
  return {
    ...(result.outcome === "completed" ? {} : { isError: true as const }),
    content: [{ type: "text" as const, text }],
    structuredContent,
  };
}

export function createMcpServer(
  config: BridgeConfig,
  registry: WorkspaceRegistry,
  codex?: CodexTaskManager,
  worktreeCheckpoints: WorktreeCheckpointStore = new WorktreeCheckpointStore(),
  localMcpRegistry: LocalMcpRegistry = new LocalMcpRegistry(config),
): McpServer {
  const server = new McpServer(
    { name: "chatgpt-mcp-bridge", version: "0.1.0" },
    { instructions: "Pass an explicitly configured workspaceId to every tool. open_workspace is optional metadata/context discovery; it does not grant access. All paths are workspace-relative. Prefer apply_patch over write_file for existing files. Never request secrets or blocked paths. Standard command execution is limited to configured package scripts and Controlled Recipes. Workspaces explicitly configured as trusted-dev additionally permit trusted host developer execution and normal interactive desktop launches; those capabilities are not OS sandboxes." },
  );
  const commands = new ControlledCommandRunner();
  const trustedDevCommands = new TrustedDevCommandRunner();
  const desktopApps = new DesktopAppLauncher();
  const recipes = new RecipeRunner();
  const processes = new ProcessInspector();
  const requireCodex = (): CodexTaskManager => {
    if (!codex) throw new CodexBridgeError("Codex integration is not enabled for this Bridge");
    return codex;
  };

  server.registerTool("mcp_server_list", {
    title: "List local MCP servers",
    description: "List configured loopback MCP servers and whether each one is currently loaded in the Bridge runtime registry.",
    inputSchema: z.object({ workspaceId: workspaceIdSchema.optional() }).strict(),
    outputSchema: z.object({
      servers: z.array(z.object({
        workspaceId: z.string(),
        serverId: z.string(),
        url: z.string(),
        loaded: z.boolean(),
      })),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ workspaceId }) => {
    try {
      const servers = localMcpRegistry.list(workspaceId);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ servers }) }],
        structuredContent: { servers },
      };
    } catch (error) { return toolError(error); }
  });

  server.registerTool("mcp_server_load", {
    title: "Load local MCP server",
    description: "Enable proxy access to one configured loopback MCP server without starting or owning its process.",
    inputSchema: z.object({
      workspaceId: workspaceIdSchema,
      serverId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u),
    }).strict(),
    outputSchema: z.object({ workspaceId: z.string(), serverId: z.string(), url: z.string(), loaded: z.boolean() }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ workspaceId, serverId }) => {
    try {
      const entry = await localMcpRegistry.load(workspaceId, serverId);
      const structuredContent = { ...entry };
      return { content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }], structuredContent };
    } catch (error) { return toolError(error); }
  });

  server.registerTool("mcp_server_unload", {
    title: "Unload local MCP server",
    description: "Disable proxy access to one configured loopback MCP server without stopping or modifying its process.",
    inputSchema: z.object({
      workspaceId: workspaceIdSchema,
      serverId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u),
    }).strict(),
    outputSchema: z.object({ workspaceId: z.string(), serverId: z.string(), url: z.string(), loaded: z.boolean() }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ workspaceId, serverId }) => {
    try {
      const entry = await localMcpRegistry.unload(workspaceId, serverId);
      const structuredContent = { ...entry };
      return { content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }], structuredContent };
    } catch (error) { return toolError(error); }
  });

  server.registerTool("mcp_server_probe", {
    title: "Probe local MCP server",
    description: "Connect to one configured local MCP server even when unloaded and report whether its tools can be listed. This never starts or stops the downstream process.",
    inputSchema: z.object({
      workspaceId: workspaceIdSchema,
      serverId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u),
    }).strict(),
    outputSchema: z.object({
      workspaceId: z.string(),
      serverId: z.string(),
      loaded: z.boolean(),
      reachable: z.boolean(),
      toolCount: z.number().int().nonnegative(),
      error: z.string().optional(),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ workspaceId, serverId }) => {
    try {
      const wasLoaded = localMcpRegistry.isLoaded(workspaceId, serverId);
      try {
        const result = await listLocalMcpTools(localMcpRegistry, workspaceId, serverId, { requireLoaded: false });
        const structuredContent = { workspaceId, serverId, loaded: wasLoaded, reachable: true, toolCount: result.tools.length };
        return { content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }], structuredContent };
      } catch (error) {
        const structuredContent = {
          workspaceId,
          serverId,
          loaded: wasLoaded,
          reachable: false,
          toolCount: 0,
          error: errorText(error),
        };
        return { content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }], structuredContent };
      }
    } catch (error) { return toolError(error); }
  });

  server.registerTool("mcp_list_tools", {
    title: "List configured local MCP tools",
    description: "List tools from one explicitly configured loopback MCP server bound to a workspace. Arbitrary URLs are not accepted.",
    inputSchema: z.object({
      workspaceId: workspaceIdSchema,
      serverId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u),
    }).strict(),
    outputSchema: z.object({
      workspaceId: z.string(),
      serverId: z.string(),
      tools: z.array(z.object({
        name: z.string(),
        description: z.string().optional(),
        inputSchema: z.unknown(),
        outputSchema: z.unknown().optional(),
        annotations: z.unknown().optional(),
      })),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ workspaceId, serverId }) => {
    try {
      const structuredContent = await listLocalMcpTools(localMcpRegistry, workspaceId, serverId);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
        structuredContent,
      };
    } catch (error) { return toolError(error); }
  });

  server.registerTool("mcp_call_tool", {
    title: "Call configured local MCP tool",
    description: "Call one tool on an explicitly configured loopback MCP server bound to a workspace. The server URL cannot be supplied by the caller.",
    inputSchema: z.object({
      workspaceId: workspaceIdSchema,
      serverId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u),
      toolName: z.string().min(1).max(256),
      arguments: z.record(z.string(), z.unknown()).optional(),
    }).strict(),
    outputSchema: z.object({
      workspaceId: z.string(),
      serverId: z.string(),
      toolName: z.string(),
      downstreamIsError: z.boolean(),
      content: z.array(z.unknown()),
      structuredContent: z.unknown().optional(),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ workspaceId, serverId, toolName, arguments: args }) => {
    try {
      const structuredContent = await callLocalMcpTool(localMcpRegistry, workspaceId, serverId, toolName, args ?? {});
      return {
        ...(structuredContent.downstreamIsError ? { isError: true as const } : {}),
        content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
        structuredContent,
      };
    } catch (error) { return toolError(error); }
  });

  server.registerTool("list_workspaces", {
    title: "List workspaces",
    description: "List the local project roots explicitly configured for this bridge so a client can discover valid workspace IDs.",
    inputSchema: z.object({}).strict(),
    outputSchema: z.object({
      workspaces: z.array(z.object({
        workspaceId: z.string(),
        root: z.string(),
        mode: z.enum(["readonly", "workspace", "trusted-dev", "handoff"]),
        maxReadBytes: z.number().int().positive(),
        allowedScripts: z.array(z.string()),
      })),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async () => {
    const workspaces = registry.listWorkspaces().map(({ workspaceId, root, mode, maxReadBytes, allowedScripts }) => ({
      workspaceId,
      root,
      mode,
      maxReadBytes,
      allowedScripts: [...allowedScripts],
    }));
    return {
      content: [{ type: "text", text: JSON.stringify({ workspaces }) }],
      structuredContent: { workspaces },
    };
  });

  server.registerTool("open_workspace", {
    title: "Open workspace",
    description: "Inspect an explicitly configured local workspace and load its project instructions. This is metadata/context discovery, not an authorization step.",
    inputSchema: z.object({ workspaceId: workspaceIdSchema }).strict(),
    outputSchema: z.object({
      workspaceId: z.string(),
      mode: z.enum(["readonly", "workspace", "trusted-dev", "handoff"]),
      maxReadBytes: z.number().int().positive(),
      allowedScripts: z.array(z.string()),
      context: z.array(workspaceContextSchema),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ workspaceId }) => {
    try {
      const workspace = await registry.openWorkspace(workspaceId);
      return {
        content: [{ type: "text", text: `Workspace '${workspace.workspaceId}' is ready in ${workspace.mode} mode.` }],
        structuredContent: {
          workspaceId: workspace.workspaceId,
          mode: workspace.mode,
          maxReadBytes: workspace.maxReadBytes,
          allowedScripts: workspace.allowedScripts,
          context: workspace.context ?? [],
        },
      };
    } catch (error) { return toolError(error); }
  });

  server.registerTool("get_workspace_info", {
    title: "Get workspace info",
    description: "Return the configured root, mode, and allowed package scripts for one workspace without reading project files.",
    inputSchema: z.object({ workspaceId: workspaceIdSchema }).strict(),
    outputSchema: z.object({
      workspaceId: z.string(),
      root: z.string(),
      mode: z.enum(["readonly", "workspace", "trusted-dev", "handoff"]),
      maxReadBytes: z.number().int().positive(),
      allowedScripts: z.array(z.string()),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ workspaceId }) => {
    try {
      const workspace = registry.listWorkspaces().find((candidate) => candidate.workspaceId === workspaceId);
      if (!workspace) throw new WorkspaceNotFoundError(workspaceId);
      const structuredContent = {
        workspaceId: workspace.workspaceId,
        root: workspace.root,
        mode: workspace.mode,
        maxReadBytes: workspace.maxReadBytes,
        allowedScripts: [...workspace.allowedScripts],
      };
      return {
        content: [{ type: "text", text: JSON.stringify(structuredContent) }],
        structuredContent,
      };
    } catch (error) { return toolError(error); }
  });

  server.registerTool("read_file", {
    title: "Read file",
    description: "Read a UTF-8 text file from a configured workspace. For files over the configured limit, pass byte offset/limit and continue with nextOffset until eof. Paths must be workspace-relative; secrets and build/cache paths are blocked.",
    inputSchema: z.object({
      workspaceId: workspaceIdSchema,
      path: relativePathSchema,
      offset: z.number().int().nonnegative().optional(),
      limit: z.number().int().min(4).max(50 * 1024 * 1024).optional(),
    }).strict(),
    outputSchema: readFileResultSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ workspaceId, path, offset, limit }) => {
    try {
      const file = await registry.readFile(workspaceId, path, {
        ...(offset !== undefined ? { offset } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
      const structuredContent = {
        workspaceId: file.workspaceId,
        path: file.path,
        content: file.content,
        bytes: file.bytes,
        ...(file.offset !== undefined ? { offset: file.offset } : {}),
        ...(file.nextOffset !== undefined ? { nextOffset: file.nextOffset } : {}),
        ...(file.totalBytes !== undefined ? { totalBytes: file.totalBytes } : {}),
        ...(file.eof !== undefined ? { eof: file.eof } : {}),
      };
      return {
        content: [{ type: "text", text: file.content }],
        structuredContent,
      };
    } catch (error) { return toolError(error); }
  });

  server.registerTool("download_file", {
    title: "Download file to workspace",
    description: "Download one public HTTP/HTTPS URL on the local Bridge host and save it to an exact workspace-relative target path. The target parent must already exist and existing targets are never overwritten. Local/private/link-local destinations and redirect hops are rejected; downloads are streamed, bounded to 5 GiB, and timed out after 10 minutes.",
    inputSchema: z.object({
      workspaceId: workspaceIdSchema,
      url: z.string().url().max(8192),
      targetPath: relativePathSchema,
    }).strict(),
    outputSchema: z.object({
      workspaceId: z.string(),
      path: z.string(),
      sourceUrl: z.string(),
      finalUrl: z.string(),
      bytes: z.number().int().nonnegative(),
      contentHash: z.string().regex(/^[0-9a-f]{64}$/u),
      contentType: z.string().optional(),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ workspaceId, url, targetPath }) => {
    try {
      const result = await downloadFile(registry, { workspaceId, url, targetPath });
      const structuredContent = { ...result };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
        structuredContent,
      };
    } catch (error) { return toolError(error); }
  });

  server.registerTool("get_image", {
    title: "Get image",
    description: "Read a safe PNG, JPEG, WebP, or GIF image from a configured workspace and return it as MCP image content for visual inspection.",
    inputSchema: z.object({ workspaceId: workspaceIdSchema, path: relativePathSchema }).strict(),
    outputSchema: z.object({
      workspaceId: z.string(),
      path: z.string(),
      mimeType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
      bytes: z.number().int().nonnegative(),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ workspaceId, path }) => {
    try {
      const image = await getImage(registry, workspaceId, path);
      const structuredContent = {
        workspaceId: image.workspaceId,
        path: image.path,
        mimeType: image.mimeType,
        bytes: image.bytes,
      };
      return {
        content: [{ type: "image" as const, data: image.data.toString("base64"), mimeType: image.mimeType }],
        structuredContent,
      };
    } catch (error) { return toolError(error); }
  });

  server.registerTool("get_pdf_info", {
    title: "Get PDF info",
    description: "Inspect a safe PDF inside a configured workspace and return its file size and page count without exposing the PDF bytes.",
    inputSchema: z.object({ workspaceId: workspaceIdSchema, path: relativePathSchema }).strict(),
    outputSchema: z.object({
      workspaceId: z.string(),
      path: z.string(),
      bytes: z.number().int().nonnegative(),
      pageCount: z.number().int().positive(),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ workspaceId, path }) => {
    try {
      const info = await getPdfInfo(registry, workspaceId, path);
      const structuredContent = { ...info };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
        structuredContent,
      };
    } catch (error) { return toolError(error); }
  });

  server.registerTool("extract_pdf_text", {
    title: "Extract PDF text",
    description: "Extract the existing text layer from a safe workspace PDF without OCR. Page numbers are one-based; a single request is limited to 20 pages and bounded text output.",
    inputSchema: z.object({
      workspaceId: workspaceIdSchema,
      path: relativePathSchema,
      startPage: z.number().int().positive().optional(),
      endPage: z.number().int().positive().optional(),
    }).strict(),
    outputSchema: z.object({
      workspaceId: z.string(),
      path: z.string(),
      pageCount: z.number().int().positive(),
      startPage: z.number().int().positive(),
      endPage: z.number().int().nonnegative(),
      pages: z.array(z.object({ page: z.number().int().positive(), text: z.string() })),
      truncated: z.boolean(),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ workspaceId, path, startPage, endPage }) => {
    try {
      const extracted = await extractPdfText(registry, workspaceId, path, {
        ...(startPage !== undefined ? { startPage } : {}),
        ...(endPage !== undefined ? { endPage } : {}),
      });
      const structuredContent = { ...extracted, pages: [...extracted.pages] };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
        structuredContent,
      };
    } catch (error) { return toolError(error); }
  });

  server.registerTool("render_pdf_page", {
    title: "Render PDF page",
    description: "Render one page of a safe workspace PDF to PNG and return it as MCP image content. Page numbers are one-based and output dimensions are bounded.",
    inputSchema: z.object({
      workspaceId: workspaceIdSchema,
      path: relativePathSchema,
      page: z.number().int().positive(),
      maxDimension: z.number().int().min(256).max(4096).default(2400),
    }).strict(),
    outputSchema: z.object({
      workspaceId: z.string(),
      path: z.string(),
      page: z.number().int().positive(),
      pageCount: z.number().int().positive(),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      mimeType: z.literal("image/png"),
      bytes: z.number().int().nonnegative(),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ workspaceId, path, page, maxDimension }) => {
    try {
      const rendered = await renderPdfPage(registry, workspaceId, path, { page, maxDimension });
      const structuredContent = {
        workspaceId: rendered.workspaceId,
        path: rendered.path,
        page: rendered.page,
        pageCount: rendered.pageCount,
        width: rendered.width,
        height: rendered.height,
        mimeType: rendered.mimeType,
        bytes: rendered.bytes,
      };
      return {
        content: [{ type: "image" as const, data: rendered.data.toString("base64"), mimeType: rendered.mimeType }],
        structuredContent,
      };
    } catch (error) { return toolError(error); }
  });

  server.registerTool("list_directory", {
    title: "List directory",
    description: "List one stable page of safe files and directories inside a configured workspace. Continue with nextCursor while truncated is true. Blocked and symbolic-link entries are omitted.",
    inputSchema: z.object({
      workspaceId: workspaceIdSchema,
      path: relativePathSchema.default("."),
      cursor: z.string().min(1).max(128).optional(),
      limit: z.number().int().min(1).max(MAX_DIRECTORY_ENTRIES).default(100),
    }).strict(),
    outputSchema: z.object({
      workspaceId: z.string(),
      path: z.string(),
      entries: z.array(z.object({
        name: z.string(),
        path: z.string(),
        kind: z.enum(["file", "directory"]),
        size: z.number().int().nonnegative().optional(),
      })),
      ...paginationSchema,
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ workspaceId, path, cursor, limit }) => {
    try {
      const result = await registry.listDirectoryPage(workspaceId, path, {
        ...(cursor ? { cursor } : {}),
        limit,
      });
      const structuredContent = { ...result };
      return {
        content: [{ type: "text", text: JSON.stringify(structuredContent) }],
        structuredContent,
      };
    } catch (error) { return toolError(error); }
  });

  server.registerTool("search", {
    title: "Search workspace",
    description: "Search safe file names and UTF-8 file contents within a configured workspace. Results are bounded and never include blocked paths.",
    inputSchema: z.object({
      workspaceId: workspaceIdSchema,
      query: z.string().min(1).max(1024),
      path: relativePathSchema.default("."),
      maxResults: z.number().int().min(1).max(500).default(100),
      maxDepth: z.number().int().min(0).max(64).default(32),
      includeContent: z.boolean().default(true),
      caseSensitive: z.boolean().default(false),
      maxFileBytes: z.number().int().min(1).max(50 * 1024 * 1024).optional(),
      cursor: z.string().min(1).max(128).optional(),
    }).strict(),
    outputSchema: z.object({
      workspaceId: z.string(),
      query: z.string(),
      results: z.array(searchResultSchema),
      ...paginationSchema,
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ workspaceId, query, path, maxResults, maxDepth, includeContent, caseSensitive, maxFileBytes, cursor }) => {
    try {
      const result = await registry.search(workspaceId, query, {
        path,
        maxResults,
        maxDepth,
        includeContent,
        caseSensitive,
        ...(maxFileBytes !== undefined ? { maxFileBytes } : {}),
        ...(cursor ? { cursor } : {}),
      });
      const structuredContent = { ...result };
      return {
        content: [{ type: "text", text: JSON.stringify(structuredContent) }],
        structuredContent,
      };
    } catch (error) { return toolError(error); }
  });

  server.registerTool("read_files", {
    title: "Read multiple files",
    description: "Read up to 20 safe UTF-8 workspace files in one bounded request. Each file remains subject to the workspace read limit and the combined returned content is capped by maxTotalBytes.",
    inputSchema: z.object({
      workspaceId: workspaceIdSchema,
      paths: z.array(relativePathSchema).min(1).max(20),
      maxTotalBytes: z.number().int().min(1).max(8 * 1024 * 1024).default(2 * 1024 * 1024),
    }).strict(),
    outputSchema: z.object({
      workspaceId: z.string(),
      files: z.array(readFileResultSchema),
      totalBytes: z.number().int().nonnegative(),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ workspaceId, paths, maxTotalBytes }) => {
    try {
      const result = await registry.readFiles(workspaceId, paths, maxTotalBytes);
      const structuredContent = { workspaceId: result.workspaceId, files: [...result.files], totalBytes: result.totalBytes };
      return { content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }], structuredContent };
    } catch (error) { return toolError(error); }
  });

  server.registerTool("stat_files", {
    title: "Stat multiple files",
    description: "Inspect metadata for up to 100 safe workspace paths in one request. Optional SHA-256 hashing keeps the existing per-file read-size limit and also enforces an aggregate hash-byte budget.",
    inputSchema: z.object({
      workspaceId: workspaceIdSchema,
      paths: z.array(relativePathSchema).min(1).max(100),
      includeHash: z.boolean().default(false),
      maxTotalHashBytes: z.number().int().min(1).max(512 * 1024 * 1024).default(64 * 1024 * 1024),
    }).strict(),
    outputSchema: z.object({
      workspaceId: z.string(),
      files: z.array(z.object({
        workspaceId: z.string(),
        path: z.string(),
        kind: z.enum(["file", "directory"]),
        size: z.number().int().nonnegative().optional(),
        mtimeMs: z.number().nonnegative(),
        contentHash: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
      })),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ workspaceId, paths, includeHash, maxTotalHashBytes }) => {
    try {
      const result = await registry.statFiles(workspaceId, paths, { includeHash, maxTotalHashBytes });
      const structuredContent = { workspaceId: result.workspaceId, files: [...result.files] };
      return { content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }], structuredContent };
    } catch (error) { return toolError(error); }
  });

  server.registerTool("snapshot_tree", {
    title: "Snapshot directory tree",
    description: "Create an ephemeral read-only manifest snapshot of a safe workspace directory. Snapshots expire after ten minutes, are bounded by depth/file/directory/total-entry/hash-byte limits, and may optionally include SHA-256 hashes for content comparison.",
    inputSchema: z.object({
      workspaceId: workspaceIdSchema,
      path: relativePathSchema.default("."),
      includeHash: z.boolean().default(false),
      include: z.array(z.string().min(1).max(1024)).max(32).optional(),
      exclude: z.array(z.string().min(1).max(1024)).max(32).optional(),
      maxFiles: z.number().int().min(1).max(10_000).default(2_000),
      maxDirectories: z.number().int().min(1).max(10_000).default(2_000),
      maxEntries: z.number().int().min(1).max(20_000).default(4_000),
      maxDepth: z.number().int().min(0).max(64).default(32),
      maxTotalHashBytes: z.number().int().min(1).max(1024 * 1024 * 1024).default(256 * 1024 * 1024),
    }).strict(),
    outputSchema: z.object({
      workspaceId: z.string(),
      snapshotId: z.string().uuid(),
      path: z.string(),
      includeHash: z.boolean(),
      files: z.number().int().nonnegative(),
      directories: z.number().int().positive(),
      bytes: z.number().int().nonnegative(),
      hashedBytes: z.number().int().nonnegative(),
      expiresAt: z.number().int().positive(),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ workspaceId, path, includeHash, include, exclude, maxFiles, maxDirectories, maxEntries, maxDepth, maxTotalHashBytes }) => {
    try {
      const result = await registry.snapshotTree(workspaceId, path, {
        includeHash,
        ...(include ? { include } : {}),
        ...(exclude ? { exclude } : {}),
        maxFiles,
        maxDirectories,
        maxEntries,
        maxDepth,
        maxTotalHashBytes,
      });
      const structuredContent = { ...result };
      return { content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }], structuredContent };
    } catch (error) { return toolError(error); }
  });

  server.registerTool("compare_tree", {
    title: "Compare directory snapshots",
    description: "Compare two unexpired snapshots from the same workspace. If both snapshots contain SHA-256 hashes, files are compared by content hash; otherwise file size is used. Difference lists are bounded.",
    inputSchema: z.object({
      workspaceId: workspaceIdSchema,
      leftSnapshotId: z.string().uuid(),
      rightSnapshotId: z.string().uuid(),
      maxDifferences: z.number().int().min(1).max(2_000).default(500),
    }).strict(),
    outputSchema: z.object({
      workspaceId: z.string(),
      leftSnapshotId: z.string().uuid(),
      rightSnapshotId: z.string().uuid(),
      comparisonMode: z.enum(["sha256", "size"]),
      identical: z.number().int().nonnegative(),
      changed: z.array(z.string()),
      missingLeft: z.array(z.string()),
      missingRight: z.array(z.string()),
      truncated: z.boolean(),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ workspaceId, leftSnapshotId, rightSnapshotId, maxDifferences }) => {
    try {
      const result = registry.compareTreeSnapshots(workspaceId, leftSnapshotId, rightSnapshotId, maxDifferences);
      const structuredContent = { ...result };
      return { content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }], structuredContent };
    } catch (error) { return toolError(error); }
  });

  server.registerTool("stat_file", {
    title: "Stat file",
    description: "Inspect safe file or directory metadata. Optionally compute a SHA-256 content hash for a regular file within the configured read limit.",
    inputSchema: z.object({
      workspaceId: workspaceIdSchema,
      path: relativePathSchema,
      includeHash: z.boolean().default(false),
    }).strict(),
    outputSchema: z.object({
      workspaceId: z.string(),
      path: z.string(),
      kind: z.enum(["file", "directory"]),
      size: z.number().int().nonnegative().optional(),
      mtimeMs: z.number().nonnegative(),
      contentHash: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ workspaceId, path, includeHash }) => {
    try {
      const result = await registry.statFile(workspaceId, path, { includeHash });
      const structuredContent = { ...result };
      return { content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent };
    } catch (error) { return toolError(error); }
  });

  server.registerTool("find_files", {
    title: "Find files",
    description: "Find safe regular files by a workspace-relative glob pattern such as **/*.test.ts. Continue with nextCursor while truncated is true.",
    inputSchema: z.object({
      workspaceId: workspaceIdSchema,
      pattern: z.string().min(1).max(1024),
      path: relativePathSchema.default("."),
      maxResults: z.number().int().min(1).max(500).default(100),
      maxDepth: z.number().int().min(0).max(64).default(32),
      caseSensitive: z.boolean().default(false),
      cursor: z.string().min(1).max(128).optional(),
    }).strict(),
    outputSchema: z.object({
      workspaceId: z.string(),
      pattern: z.string(),
      results: z.array(z.object({ path: z.string(), size: z.number().int().nonnegative() })),
      ...paginationSchema,
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ workspaceId, pattern, path, maxResults, maxDepth, caseSensitive, cursor }) => {
    try {
      const result = await registry.findFiles(workspaceId, pattern, {
        path, maxResults, maxDepth, caseSensitive, ...(cursor ? { cursor } : {}),
      });
      const structuredContent = { ...result };
      return { content: [{ type: "text", text: JSON.stringify(structuredContent) }], structuredContent };
    } catch (error) { return toolError(error); }
  });

  server.registerTool("apply_patch", {
    title: "Apply patch",
    description: "Prefer this to update an existing source file in workspace mode. Accepts a unified diff or exact-match hunks; failure is atomic.",
    inputSchema: z.object({
      workspaceId: workspaceIdSchema,
      path: relativePathSchema,
      patch: z.union([z.string().min(1).max(2 * 1024 * 1024), exactPatchSchema]),
    }).strict(),
    outputSchema: writeResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async ({ workspaceId, path, patch }) => {
    try {
      const result = await registry.applyPatch(workspaceId, path, patch);
      return {
        content: [{ type: "text", text: `Patched ${path}` }],
        structuredContent: { workspaceId: result.workspaceId, path: result.path, bytes: result.bytes },
      };
    } catch (error) { return toolError(error); }
  });

  server.registerTool("write_file", {
    title: "Write file",
    description: "Create or replace a UTF-8 file in workspace mode. Prefer apply_patch when modifying an existing file.",
    inputSchema: z.object({ workspaceId: workspaceIdSchema, path: relativePathSchema, content: z.string().max(2 * 1024 * 1024) }).strict(),
    outputSchema: writeResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, async ({ workspaceId, path, content }) => {
    try {
      const result = await registry.writeFile(workspaceId, path, content);
      return {
        content: [{ type: "text", text: `Wrote ${result.bytes} bytes to ${path}` }],
        structuredContent: { workspaceId: result.workspaceId, path: result.path, bytes: result.bytes },
      };
    } catch (error) { return toolError(error); }
  });

  server.registerTool("write_file_begin", {
    title: "Begin chunked file write",
    description: "Begin a bounded chunked UTF-8 file write for large source/generated text. Data is written to a private temporary file and the target path is not replaced until write_file_commit succeeds.",
    inputSchema: z.object({
      workspaceId: workspaceIdSchema,
      path: relativePathSchema,
      totalBytes: z.number().int().nonnegative().max(128 * 1024 * 1024).optional(),
      expectedSha256: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
      maxBytes: z.number().int().min(1).max(128 * 1024 * 1024).optional(),
    }).strict(),
    outputSchema: z.object({
      workspaceId: z.string(),
      uploadId: z.string().uuid(),
      path: z.string(),
      chunkSize: z.number().int().positive(),
      maxBytes: z.number().int().positive(),
      expiresAt: z.number().int().positive(),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ workspaceId, path, totalBytes, expectedSha256, maxBytes }) => {
    try {
      const result = await registry.beginChunkedWrite(workspaceId, path, {
        ...(totalBytes !== undefined ? { totalBytes } : {}),
        ...(expectedSha256 !== undefined ? { expectedHash: expectedSha256 } : {}),
        ...(maxBytes !== undefined ? { maxBytes } : {}),
      });
      const structuredContent = { ...result };
      return { content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }], structuredContent };
    } catch (error) { return toolError(error); }
  });

  server.registerTool("write_file_chunk", {
    title: "Write file chunk",
    description: "Append the next UTF-8 chunk to an active chunked write. offset is a byte offset and must exactly equal the bytesReceived returned by the previous chunk. Each chunk is limited to 512 KiB.",
    inputSchema: z.object({
      workspaceId: workspaceIdSchema,
      uploadId: z.string().uuid(),
      offset: z.number().int().nonnegative(),
      content: z.string().min(1).max(512 * 1024),
    }).strict(),
    outputSchema: z.object({
      workspaceId: z.string(),
      uploadId: z.string().uuid(),
      path: z.string(),
      bytesReceived: z.number().int().nonnegative(),
      expiresAt: z.number().int().positive(),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ workspaceId, uploadId, offset, content }) => {
    try {
      const result = await registry.writeChunk(workspaceId, uploadId, offset, content);
      const structuredContent = { ...result };
      return { content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }], structuredContent };
    } catch (error) { return toolError(error); }
  });

  server.registerTool("write_file_commit", {
    title: "Commit chunked file write",
    description: "Validate and atomically replace/create the target file from a completed chunked write. If totalBytes or expectedSha256 were declared at begin time they must match before commit.",
    inputSchema: z.object({
      workspaceId: workspaceIdSchema,
      uploadId: z.string().uuid(),
    }).strict(),
    outputSchema: z.object({
      workspaceId: z.string(),
      uploadId: z.string().uuid(),
      path: z.string(),
      bytes: z.number().int().nonnegative(),
      contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async ({ workspaceId, uploadId }) => {
    try {
      const result = await registry.commitChunkedWrite(workspaceId, uploadId);
      const structuredContent = { ...result };
      return { content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }], structuredContent };
    } catch (error) { return toolError(error); }
  });

  server.registerTool("write_file_abort", {
    title: "Abort chunked file write",
    description: "Abort an active chunked write and delete its private temporary file without changing the target path.",
    inputSchema: z.object({
      workspaceId: workspaceIdSchema,
      uploadId: z.string().uuid(),
    }).strict(),
    outputSchema: z.object({
      workspaceId: z.string(),
      uploadId: z.string().uuid(),
      aborted: z.literal(true),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ workspaceId, uploadId }) => {
    try {
      const result = await registry.abortChunkedWrite(workspaceId, uploadId);
      const structuredContent = { ...result };
      return { content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }], structuredContent };
    } catch (error) { return toolError(error); }
  });

  server.registerTool("create_directory", {
    title: "Create directory",
    description: "Create one directory inside a workspace. Its parent must already exist; blocked paths and non-workspace modes are rejected.",
    inputSchema: z.object({ workspaceId: workspaceIdSchema, path: relativePathSchema }).strict(),
    outputSchema: z.object({ workspaceId: z.string(), path: z.string() }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ workspaceId, path }) => {
    try {
      const result = await registry.createDirectory(workspaceId, path);
      return {
        content: [{ type: "text", text: `Created directory ${path}` }],
        structuredContent: { workspaceId: result.workspaceId, path: result.path },
      };
    } catch (error) { return toolError(error); }
  });

  server.registerTool("mkdir_p", {
    title: "Create directory tree",
    description: "Create a workspace-relative directory and any missing parent directories. Existing directories are preserved; files, blocked paths, traversal, symlinks, and non-workspace modes are rejected.",
    inputSchema: z.object({ workspaceId: workspaceIdSchema, path: relativePathSchema }).strict(),
    outputSchema: z.object({ workspaceId: z.string(), path: z.string(), created: z.array(z.string()) }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ workspaceId, path }) => {
    try {
      const result = await registry.createDirectories(workspaceId, path);
      const structuredContent = { workspaceId: result.workspaceId, path: result.path, created: [...result.created] };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
        structuredContent,
      };
    } catch (error) { return toolError(error); }
  });

  server.registerTool("copy_file", {
    title: "Copy file",
    description: "Copy one regular file inside a workspace without replacing an existing target. Source and target remain subject to the workspace path sandbox and blocked-path policy.",
    inputSchema: z.object({
      workspaceId: workspaceIdSchema,
      sourcePath: relativePathSchema,
      targetPath: relativePathSchema,
    }).strict(),
    outputSchema: z.object({
      workspaceId: z.string(),
      sourcePath: z.string(),
      targetPath: z.string(),
      bytes: z.number().int().nonnegative(),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ workspaceId, sourcePath, targetPath }) => {
    try {
      const result = await registry.copyFile(workspaceId, sourcePath, targetPath);
      return {
        content: [{ type: "text", text: `Copied ${sourcePath} to ${targetPath}` }],
        structuredContent: {
          workspaceId: result.workspaceId,
          sourcePath: result.sourcePath,
          targetPath: result.targetPath,
          bytes: result.bytes,
        },
      };
    } catch (error) { return toolError(error); }
  });

  server.registerTool("copy_tree", {
    title: "Copy directory tree",
    description: "Copy one safe directory tree to a new exact target path without overwriting existing content. Optional include/exclude globs are workspace-relative to the source tree. The operation is bounded by file/directory/total-entry and byte limits, copies from stable opened source handles, and rolls back its newly created target tree if copying fails.",
    inputSchema: z.object({
      workspaceId: workspaceIdSchema,
      sourcePath: relativePathSchema,
      targetPath: relativePathSchema,
      include: z.array(z.string().min(1).max(1024)).max(32).optional(),
      exclude: z.array(z.string().min(1).max(1024)).max(32).optional(),
      maxFiles: z.number().int().min(1).max(10_000).default(2_000),
      maxDirectories: z.number().int().min(1).max(10_000).default(2_000),
      maxEntries: z.number().int().min(1).max(20_000).default(4_000),
      maxTotalBytes: z.number().int().min(1).max(2 * 1024 * 1024 * 1024).default(512 * 1024 * 1024),
    }).strict(),
    outputSchema: z.object({
      workspaceId: z.string(),
      sourcePath: z.string(),
      targetPath: z.string(),
      files: z.number().int().nonnegative(),
      directories: z.number().int().positive(),
      bytes: z.number().int().nonnegative(),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ workspaceId, sourcePath, targetPath, include, exclude, maxFiles, maxDirectories, maxEntries, maxTotalBytes }) => {
    try {
      const result = await registry.copyTree(workspaceId, sourcePath, targetPath, {
        ...(include ? { include } : {}),
        ...(exclude ? { exclude } : {}),
        maxFiles,
        maxDirectories,
        maxEntries,
        maxTotalBytes,
      });
      const structuredContent = { ...result };
      return { content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }], structuredContent };
    } catch (error) { return toolError(error); }
  });

  server.registerTool("prepare_file_plan", {
    title: "Prepare file plan",
    description: "Preflight a bounded ordered file plan containing mkdir, copy, and move operations only. No files are changed. The returned one-shot planId expires after five minutes; execute_file_plan revalidates source and target preconditions before applying it. Batch delete is intentionally unsupported.",
    inputSchema: z.object({
      workspaceId: workspaceIdSchema,
      operations: z.array(z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("mkdir"), path: relativePathSchema }).strict(),
        z.object({
          kind: z.literal("copy"),
          sourcePath: relativePathSchema,
          targetPath: relativePathSchema,
          expectedHash: z.string().regex(/^[a-f0-9]{64}$/iu).optional(),
        }).strict(),
        z.object({
          kind: z.literal("move"),
          sourcePath: relativePathSchema,
          targetPath: relativePathSchema,
          expectedHash: z.string().regex(/^[a-f0-9]{64}$/iu).optional(),
        }).strict(),
      ])).min(1).max(200),
    }).strict(),
    outputSchema: z.object({
      workspaceId: z.string(),
      planId: z.string().uuid(),
      expiresAt: z.number().int().positive(),
      operations: z.number().int().positive(),
      mkdir: z.number().int().nonnegative(),
      copy: z.number().int().nonnegative(),
      move: z.number().int().nonnegative(),
      bytes: z.number().int().nonnegative(),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ workspaceId, operations }) => {
    try {
      const normalizedOperations = operations.map((operation) => operation.kind === "mkdir"
        ? operation
        : {
            kind: operation.kind,
            sourcePath: operation.sourcePath,
            targetPath: operation.targetPath,
            ...(operation.expectedHash !== undefined ? { expectedHash: operation.expectedHash } : {}),
          });
      const result = await registry.prepareFilePlan(workspaceId, normalizedOperations);
      const structuredContent = { ...result };
      return { content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }], structuredContent };
    } catch (error) { return toolError(error); }
  });

  server.registerTool("execute_file_plan", {
    title: "Execute prepared file plan",
    description: "Execute one previously prepared one-shot file plan after revalidating all recorded preconditions. Operations are serialized within the workspace. On failure, completed mkdir/copy/move steps are rolled back when possible; an incomplete rollback is reported explicitly.",
    inputSchema: z.object({ workspaceId: workspaceIdSchema, planId: z.string().uuid() }).strict(),
    outputSchema: z.object({
      workspaceId: z.string(),
      planId: z.string().uuid(),
      operations: z.number().int().positive(),
      mkdir: z.number().int().nonnegative(),
      copy: z.number().int().nonnegative(),
      move: z.number().int().nonnegative(),
      bytes: z.number().int().nonnegative(),
      completed: z.literal(true),
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async ({ workspaceId, planId }) => {
    try {
      const result = await registry.executeFilePlan(workspaceId, planId);
      const structuredContent = { ...result };
      return { content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }], structuredContent };
    } catch (error) { return toolError(error); }
  });

  server.registerTool("move_path", {
    title: "Move or rename path",
    description: "Move or rename one regular file or directory inside a workspace without replacing an existing target. targetPath is the exact final destination path including the file or directory basename; do not pass an existing destination directory. The target parent directory must already exist.",
    inputSchema: z.object({
      workspaceId: workspaceIdSchema,
      sourcePath: relativePathSchema,
      targetPath: relativePathSchema,
    }).strict(),
    outputSchema: z.object({ workspaceId: z.string(), sourcePath: z.string(), targetPath: z.string() }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async ({ workspaceId, sourcePath, targetPath }) => {
    try {
      const result = await registry.movePath(workspaceId, sourcePath, targetPath);
      return {
        content: [{ type: "text", text: `Moved ${sourcePath} to ${targetPath}` }],
        structuredContent: {
          workspaceId: result.workspaceId,
          sourcePath: result.sourcePath,
          targetPath: result.targetPath,
        },
      };
    } catch (error) { return toolError(error); }
  });

  server.registerTool("delete_file", {
    title: "Delete file",
    description: "Delete one regular file inside a workspace. Directories, symlinks, blocked paths, and non-workspace modes are rejected.",
    inputSchema: z.object({ workspaceId: workspaceIdSchema, path: relativePathSchema }).strict(),
    outputSchema: z.object({ workspaceId: z.string(), path: z.string() }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async ({ workspaceId, path }) => {
    try {
      const result = await registry.deleteFile(workspaceId, path);
      return {
        content: [{ type: "text", text: `Deleted file ${path}` }],
        structuredContent: { workspaceId: result.workspaceId, path: result.path },
      };
    } catch (error) { return toolError(error); }
  });

  server.registerTool("delete_directory", {
    title: "Delete empty directory",
    description: "Delete one empty directory inside a workspace. Recursive deletion is intentionally not supported.",
    inputSchema: z.object({ workspaceId: workspaceIdSchema, path: relativePathSchema }).strict(),
    outputSchema: z.object({ workspaceId: z.string(), path: z.string() }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async ({ workspaceId, path }) => {
    try {
      const result = await registry.deleteDirectory(workspaceId, path);
      return {
        content: [{ type: "text", text: `Deleted directory ${path}` }],
        structuredContent: { workspaceId: result.workspaceId, path: result.path },
      };
    } catch (error) { return toolError(error); }
  });

  server.registerTool("create_worktree_checkpoint", {
    title: "Create worktree checkpoint",
    description: "Create a read-only in-memory checkpoint of the current Git HEAD and safe dirty worktree paths. Dirty regular files are SHA-256 hashed so later comparison can distinguish pre-existing changes from additional task edits. Checkpoints expire after 12 hours and are lost when the Bridge restarts.",
    inputSchema: z.object({
      workspaceId: workspaceIdSchema,
      maxHashBytes: z.number().int().min(1).max(1024 * 1024 * 1024).default(512 * 1024 * 1024),
    }).strict(),
    outputSchema: z.object({
      workspaceId: z.string(),
      checkpointId: z.string().uuid(),
      head: z.string().optional(),
      dirtyPaths: z.number().int().nonnegative(),
      ignoredPaths: z.number().int().nonnegative(),
      hashedBytes: z.number().int().nonnegative(),
      createdAt: z.number().int().positive(),
      expiresAt: z.number().int().positive(),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ workspaceId, maxHashBytes }) => {
    try {
      const workspace = await registry.openWorkspace(workspaceId);
      const result = await worktreeCheckpoints.create(workspaceId, workspace.root, maxHashBytes);
      const structuredContent = { ...result };
      return { content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }], structuredContent };
    } catch (error) { return toolError(error); }
  });

  server.registerTool("compare_worktree_checkpoint", {
    title: "Compare worktree checkpoint",
    description: "Compare the current safe Git worktree state with a prior in-memory checkpoint. Reports pre-existing dirty paths that stayed unchanged, pre-existing paths additionally modified, newly dirty paths, resolved pre-existing paths, and whether HEAD changed. This tool does not modify Git.",
    inputSchema: z.object({
      workspaceId: workspaceIdSchema,
      checkpointId: z.string().uuid(),
      maxHashBytes: z.number().int().min(1).max(1024 * 1024 * 1024).default(512 * 1024 * 1024),
      maxPaths: z.number().int().min(1).max(2_000).default(500),
    }).strict(),
    outputSchema: z.object({
      workspaceId: z.string(),
      checkpointId: z.string().uuid(),
      headBefore: z.string().optional(),
      headAfter: z.string().optional(),
      headChanged: z.boolean(),
      preExistingUnchanged: z.array(z.string()),
      preExistingAdditionallyModified: z.array(z.string()),
      addedByTask: z.array(z.string()),
      resolvedPreExisting: z.array(z.string()),
      ignoredPathsBefore: z.number().int().nonnegative(),
      ignoredPathsAfter: z.number().int().nonnegative(),
      truncated: z.boolean(),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ workspaceId, checkpointId, maxHashBytes, maxPaths }) => {
    try {
      const workspace = await registry.openWorkspace(workspaceId);
      const result = await worktreeCheckpoints.compare(workspaceId, workspace.root, checkpointId, maxHashBytes, maxPaths);
      const structuredContent = { ...result };
      return { content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }], structuredContent };
    } catch (error) { return toolError(error); }
  });

  server.registerTool("git_init", {
    title: "Initialize Git repository",
    description: "Initialize a Git repository only at the configured workspace root. No path, flags, remotes, hooks, or other Git arguments are accepted. A writable workspace mode is required; an existing repository or a workspace nested inside another repository is rejected.",
    inputSchema: z.object({ workspaceId: workspaceIdSchema }).strict(),
    outputSchema: gitResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async ({ workspaceId }) => {
    try {
      const workspace = await registry.openWorkspace(workspaceId);
      if (!isWorkspaceWritableMode(workspace.mode)) throw new PathSecurityError("PERMISSION_DENIED");
      return gitResult(await gitInit({ workspaceRoot: workspace.root }));
    } catch (error) { return toolError(error); }
  });

  server.registerTool("git_status", {
    title: "Git status",
    description: "Inspect Git status for a configured workspace without changing repository state. Sensitive and build/cache paths are excluded.",
    inputSchema: z.object({ workspaceId: workspaceIdSchema }).strict(),
    outputSchema: gitResultSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ workspaceId }) => {
    try {
      const workspace = await registry.openWorkspace(workspaceId);
      return gitResult(await gitStatus({ workspaceRoot: workspace.root }));
    } catch (error) { return toolError(error); }
  });

  server.registerTool("git_diff", {
    title: "Git diff",
    description: "Inspect the bounded working-tree diff for a configured workspace. An optional safe repository-relative path may be supplied.",
    inputSchema: z.object({ workspaceId: workspaceIdSchema, path: relativePathSchema.optional() }).strict(),
    outputSchema: gitResultSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ workspaceId, path }) => {
    try {
      const workspace = await registry.openWorkspace(workspaceId);
      return gitResult(await gitDiff({ workspaceRoot: workspace.root, ...(path ? { path } : {}) }));
    } catch (error) { return toolError(error); }
  });

  server.registerTool("git_add", {
    title: "Git add",
    description: "Stage safe workspace changes for commit. Omit paths to stage all non-blocked changes, or provide up to 100 safe repository-relative paths. Sensitive and blocked paths are rejected/excluded.",
    inputSchema: z.object({
      workspaceId: workspaceIdSchema,
      paths: z.array(relativePathSchema).min(1).max(100).optional(),
    }).strict(),
    outputSchema: gitResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ workspaceId, paths }) => {
    try {
      const workspace = await registry.openWorkspace(workspaceId);
      if (!isWorkspaceWritableMode(workspace.mode)) throw new PathSecurityError("PERMISSION_DENIED");
      return gitResult(await gitAdd({ workspaceRoot: workspace.root, ...(paths ? { paths } : {}) }));
    } catch (error) { return toolError(error); }
  });

  server.registerTool("git_commit", {
    title: "Git commit",
    description: "Commit only the currently staged safe changes with a caller-supplied message. Commit hooks and GPG signing are disabled, and blocked/sensitive staged paths cause the commit to be rejected.",
    inputSchema: z.object({
      workspaceId: workspaceIdSchema,
      message: z.string().min(1).max(500),
    }).strict(),
    outputSchema: gitResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async ({ workspaceId, message }) => {
    try {
      const workspace = await registry.openWorkspace(workspaceId);
      if (!isWorkspaceWritableMode(workspace.mode)) throw new PathSecurityError("PERMISSION_DENIED");
      return gitResult(await gitCommit({ workspaceRoot: workspace.root, message }));
    } catch (error) { return toolError(error); }
  });

  server.registerTool("git_log", {
    title: "Git log",
    description: "Inspect bounded commit history without changing repository state. An optional safe path limits history to that path.",
    inputSchema: z.object({
      workspaceId: workspaceIdSchema,
      maxCount: z.number().int().min(1).max(100).default(20),
      path: relativePathSchema.optional(),
    }).strict(),
    outputSchema: gitResultSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ workspaceId, maxCount, path }) => {
    try {
      const workspace = await registry.openWorkspace(workspaceId);
      return gitResult(await gitLog({ workspaceRoot: workspace.root, maxCount, ...(path ? { path } : {}) }));
    } catch (error) { return toolError(error); }
  });

  server.registerTool("git_show", {
    title: "Git show",
    description: "Inspect one commit without changing repository state. With path, returns that file's contents at the revision; without path, returns the bounded commit patch. Commit-ish is restricted to HEAD forms or a hexadecimal object ID.",
    inputSchema: z.object({
      workspaceId: workspaceIdSchema,
      commitish: z.string().min(1).max(64).default("HEAD"),
      path: relativePathSchema.optional(),
    }).strict(),
    outputSchema: gitResultSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ workspaceId, commitish, path }) => {
    try {
      const workspace = await registry.openWorkspace(workspaceId);
      return gitResult(await gitShow({ workspaceRoot: workspace.root, commitish, ...(path ? { path } : {}) }));
    } catch (error) { return toolError(error); }
  });

  if (codex) {
  server.registerTool("codex_get_status", {
    title: "Get Codex status",
    description: "Return the Bridge's current Codex Desktop IPC connectivity and managed task counts without opening, resuming, or selecting any Codex thread.",
    inputSchema: z.object({}).strict(),
    outputSchema: z.object({
      capabilities: z.object({
        bridgeCapabilityVersion: z.literal(BRIDGE_CAPABILITIES.bridgeCapabilityVersion),
        codexStateVersion: z.literal(BRIDGE_CAPABILITIES.codexStateVersion),
        codexModuleModel: z.literal(BRIDGE_CAPABILITIES.codexModuleModel),
        codexExecutionTransport: z.literal(BRIDGE_CAPABILITIES.codexExecutionTransport),
        codexDefaultModel: z.literal(BRIDGE_CAPABILITIES.codexDefaultModel),
        codexDefaultReasoningEffort: z.literal(BRIDGE_CAPABILITIES.codexDefaultReasoningEffort),
      }),
      desktop: z.object({
        available: z.boolean(),
        ipcConnected: z.boolean(),
        lastConnectedAt: z.string().optional(),
        lastDisconnectedAt: z.string().optional(),
        lastError: z.string().optional(),
      }),
      bridge: z.object({
        activeTasks: z.number().int().nonnegative(),
        queuedTasks: z.number().int().nonnegative(),
      }),
      knownThreads: z.array(z.object({
        workspaceId: z.string(),
        moduleId: z.string(),
        threadId: z.string(),
        ownerPresent: z.boolean(),
      })),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async () => {
    try {
      const structuredContent = await requireCodex().getStatus();
      return { content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }], structuredContent };
    } catch (error) { return toolError(error); }
  });

  server.registerTool("codex_list_modules", {
    title: "List Codex modules",
    description: "List configured long-term modules plus runtime-created temporary modules and their single current Codex thread binding. Configured modules remain after unbind/archive; temporary modules disappear when their binding is cleared or becomes invalid. Live thread metadata and Desktop owner state are refreshed when listed. ChatGPT still passes the bound threadId explicitly when continuing work.",
    inputSchema: z.object({ workspaceId: workspaceIdSchema }).strict(),
    outputSchema: z.object({ modules: z.array(codexModuleSchema) }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ workspaceId }) => {
    try {
      const modules = await requireCodex().listModules(workspaceId);
      const structuredContent = { modules: [...modules] };
      return { content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }], structuredContent };
    } catch (error) { return toolError(error); }
  });

  server.registerTool("codex_create_module", {
    title: "Create Codex long-term module",
    description: "Create one configured long-term Codex module for a workspace and apply it immediately without restarting the Bridge. If the same moduleId currently exists only as a temporary module, it is promoted to long-term and keeps its current thread binding. Pass the logical display name without a [ChatGPT] prefix; Bridge-managed thread/module names always normalize to exactly one [ChatGPT] prefix, including legacy configured names that already contain it.",
    inputSchema: z.object({
      workspaceId: workspaceIdSchema,
      moduleId: codexModuleIdSchema,
      displayName: codexModuleDisplayNameSchema,
    }).strict(),
    outputSchema: codexModuleSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ workspaceId, moduleId, displayName }) => {
    try { return codexModuleResult(await requireCodex().createConfiguredModule(workspaceId, moduleId, displayName)); }
    catch (error) { return toolError(error); }
  });

  server.registerTool("codex_update_module", {
    title: "Update Codex long-term module",
    description: "Rename one configured long-term Codex module display name and apply the change immediately without restarting the Bridge. The moduleId and any current thread binding are preserved. Pass the logical display name without a [ChatGPT] prefix; Bridge-managed thread/module names normalize legacy or caller-supplied prefixes to exactly one [ChatGPT] prefix.",
    inputSchema: z.object({
      workspaceId: workspaceIdSchema,
      moduleId: codexModuleIdSchema,
      displayName: codexModuleDisplayNameSchema,
    }).strict(),
    outputSchema: codexModuleSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ workspaceId, moduleId, displayName }) => {
    try { return codexModuleResult(await requireCodex().updateConfiguredModule(workspaceId, moduleId, displayName)); }
    catch (error) { return toolError(error); }
  });

  server.registerTool("codex_delete_module", {
    title: "Delete Codex long-term module",
    description: "Delete one configured long-term Codex module and apply the change immediately without restarting the Bridge. This clears only the Bridge module binding; it never archives or deletes the Codex conversation. Deletion is refused while that module has a queued or running task.",
    inputSchema: z.object({ workspaceId: workspaceIdSchema, moduleId: codexModuleIdSchema }).strict(),
    outputSchema: codexModuleDeleteSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async ({ workspaceId, moduleId }) => {
    try {
      const deleted = await requireCodex().deleteConfiguredModule(workspaceId, moduleId);
      const structuredContent = { ...deleted };
      return { content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }], structuredContent };
    } catch (error) { return toolError(error); }
  });

  server.registerTool("codex_list_threads", {
    title: "List Codex threads",
    description: "List Codex conversation threads restricted to the canonical cwd bound to one workspace, annotated with the current Desktop ownerPresent state. This is read-only and does not open or resume threads.",
    inputSchema: z.object({
      workspaceId: workspaceIdSchema,
      limit: z.number().int().min(1).max(100).default(20),
      cursor: z.string().min(1).max(512).optional(),
      archived: z.boolean().optional(),
    }).strict(),
    outputSchema: codexOpaqueSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ workspaceId, limit, cursor, archived }) => {
    try {
      const data = await requireCodex().listThreads(workspaceId, {
        limit,
        ...(cursor ? { cursor } : {}),
        ...(archived !== undefined ? { archived } : {}),
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(data) }], structuredContent: { data } };
    } catch (error) { return toolError(error); }
  });

  server.registerTool("codex_read_thread", {
    title: "Read Codex thread",
    description: "Read one Codex thread only after verifying it belongs to the requested workspace Codex scope.",
    inputSchema: z.object({ workspaceId: workspaceIdSchema, threadId: z.string().min(1).max(256) }).strict(),
    outputSchema: codexOpaqueSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ workspaceId, threadId }) => {
    try {
      const data = await requireCodex().readThread(workspaceId, threadId);
      return { content: [{ type: "text" as const, text: JSON.stringify(data) }], structuredContent: { data } };
    } catch (error) { return toolError(error); }
  });

  server.registerTool("codex_submit_task", {
    title: "Submit Codex task",
    description: "Submit a ChatGPT-authored Codex task. Every real task defaults to model gpt-5.6-luna with reasoning effort max. Only pass model or effort when the user explicitly requests a different value; do not autonomously choose another model. A module configured under workspace.codex.modules is a long-term module; any other valid moduleId is created dynamically as a temporary module. Bridge-managed new thread/module display names always contain exactly one [ChatGPT] prefix, even if a legacy configured display name already contains one. Each module has at most one current thread binding. If unbound, omit threadId to create and bind a new conversation or pass one existing threadId to bind it. For Codex runtimes that return an unmaterialized new thread, the Bridge performs one internal no-op bootstrap turn, waits for completion, hands the thread to Codex Desktop, then sends the caller's instruction as the first real Desktop turn. ChatGPT does not need to schedule a separate bootstrap task. If already bound, ChatGPT must explicitly pass that same threadId. Configured modules survive unbind/archive as unbound; temporary modules are removed when their binding is cleared. Archived threads are never automatically unarchived. One workspace writer runs at a time.",
    inputSchema: z.object({
      workspaceId: workspaceIdSchema,
      moduleId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u).default("general"),
      threadId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/u).optional(),
      instruction: z.string().min(1).max(64 * 1024),
      model: codexModelSchema.optional().describe(`Optional model id override. Omit unless the user explicitly requested a different model. Default: ${CODEX_DEFAULT_MODEL}.`),
      effort: codexReasoningEffortSchema.optional().describe(`Optional reasoning-effort override. Omit unless the user explicitly requested a different effort. Default: ${CODEX_DEFAULT_REASONING_EFFORT}.`),
      requestId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u).optional(),
    }).strict(),
    outputSchema: codexTaskSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async ({ workspaceId, moduleId, threadId, instruction, model, effort, requestId }) => {
    try { return codexTaskResult(await requireCodex().submitTask(workspaceId, moduleId, instruction, requestId, threadId, model, effort)); }
    catch (error) { return toolError(error); }
  });

  server.registerTool("codex_get_task", {
    title: "Get Codex task",
    description: "Get the persisted state of one Codex task without waiting for the task to finish.",
    inputSchema: z.object({ workspaceId: workspaceIdSchema, taskId: z.string().min(1).max(256) }).strict(),
    outputSchema: codexTaskSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ workspaceId, taskId }) => {
    try { return codexTaskResult(await requireCodex().getTask(workspaceId, taskId)); }
    catch (error) { return toolError(error); }
  });

  server.registerTool("codex_continue_task", {
    title: "Continue Codex task",
    description: "Queue a follow-up instruction on the exact Codex thread used by a previous task. The follow-up inherits that task's model and reasoning effort (normally gpt-5.6-luna + max); only pass model or effort when the user explicitly requests a different value. The thread must still be the module's current unarchived binding; archived or replaced bindings are rejected and never automatically unarchived.",
    inputSchema: z.object({
      workspaceId: workspaceIdSchema,
      taskId: z.string().min(1).max(256),
      instruction: z.string().min(1).max(64 * 1024),
      model: codexModelSchema.optional().describe("Optional model id override. Omit unless the user explicitly requested a different model; otherwise inherit the previous task model."),
      effort: codexReasoningEffortSchema.optional().describe("Optional reasoning-effort override. Omit unless the user explicitly requested a different effort; otherwise inherit the previous task effort."),
      requestId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u).optional(),
    }).strict(),
    outputSchema: codexTaskSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async ({ workspaceId, taskId, instruction, model, effort, requestId }) => {
    try { return codexTaskResult(await requireCodex().continueTask(workspaceId, taskId, instruction, requestId, model, effort)); }
    catch (error) { return toolError(error); }
  });

  server.registerTool("codex_cancel_task", {
    title: "Cancel Codex task",
    description: "Cancel a queued task or interrupt the active Codex turn for a workspace task.",
    inputSchema: z.object({ workspaceId: workspaceIdSchema, taskId: z.string().min(1).max(256) }).strict(),
    outputSchema: codexTaskSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ workspaceId, taskId }) => {
    try { return codexTaskResult(await requireCodex().cancelTask(workspaceId, taskId)); }
    catch (error) { return toolError(error); }
  });

  }

  const processInfoSchema = z.object({
    pid: z.number().int().positive(),
    ppid: z.number().int().nonnegative(),
    name: z.string(),
    exe: z.string().optional(),
    owner: z.string().optional(),
    windowsSessionId: z.number().int().nonnegative(),
    startTime: z.string().optional(),
  });

  server.registerTool("find_processes", {
    title: "Find Windows processes",
    description: "Find Windows processes by an exact safe executable name. Returns bounded read-only PID/PPID, executable path when available, owner, Windows session ID, and start time. Command lines and environment variables are intentionally not exposed.",
    inputSchema: z.object({
      workspaceId: workspaceIdSchema,
      name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u),
    }).strict(),
    outputSchema: z.object({ processes: z.array(processInfoSchema).max(200) }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ workspaceId, name }, extra) => {
    try {
      await registry.openWorkspace(workspaceId);
      const found = await processes.findByName(name, extra.signal);
      const structuredContent = { processes: [...found] };
      return { content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }], structuredContent };
    } catch (error) { return toolError(error); }
  });

  server.registerTool("inspect_process", {
    title: "Inspect Windows process",
    description: "Inspect one Windows PID using a fixed read-only CIM query. Returns no command line and no process environment. A missing PID returns found=false.",
    inputSchema: z.object({ workspaceId: workspaceIdSchema, pid: z.number().int().min(1).max(0x7fffffff) }).strict(),
    outputSchema: z.object({ found: z.boolean(), process: processInfoSchema.optional() }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ workspaceId, pid }, extra) => {
    try {
      await registry.openWorkspace(workspaceId);
      const processInfo = await processes.inspect(pid, extra.signal);
      const structuredContent = processInfo ? { found: true, process: processInfo } : { found: false };
      return { content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }], structuredContent };
    } catch (error) { return toolError(error); }
  });

  server.registerTool("wait_process", {
    title: "Wait for Windows process exit",
    description: "Wait a bounded time for one Windows PID to exit without terminating or modifying it. Only the exit condition is supported, with a maximum wait of 30 seconds per call.",
    inputSchema: z.object({
      workspaceId: workspaceIdSchema,
      pid: z.number().int().min(1).max(0x7fffffff),
      state: z.literal("exit").default("exit"),
      timeoutMs: z.number().int().min(1).max(30_000).default(30_000),
      pollMs: z.number().int().min(100).max(5_000).default(500),
    }).strict(),
    outputSchema: z.object({
      pid: z.number().int().positive(),
      exited: z.boolean(),
      elapsedMs: z.number().int().nonnegative(),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ workspaceId, pid, timeoutMs, pollMs }, extra) => {
    try {
      await registry.openWorkspace(workspaceId);
      const structuredContent = await processes.waitForExit(pid, timeoutMs, pollMs, extra.signal);
      return { content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }], structuredContent };
    } catch (error) { return toolError(error); }
  });

  server.registerTool("list_recipes", {
    title: "List controlled workspace recipes",
    description: "List controlled build/test recipes configured locally for one workspace. A Controlled Recipe is a fixed launcher/workflow, not an OS sandbox; executable paths and fixed arguments are intentionally not exposed through MCP.",
    inputSchema: z.object({ workspaceId: workspaceIdSchema }).strict(),
    outputSchema: z.object({
      recipes: z.array(z.object({
        recipeId: workspaceRecipeIdSchema,
        description: z.string().optional(),
        cwd: z.string().optional(),
        timeoutMs: z.number().int().positive().optional(),
      })),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ workspaceId }) => {
    try {
      const workspace = await registry.openWorkspace(workspaceId);
      if (!isWorkspaceWritableMode(workspace.mode)) throw new PathSecurityError("PERMISSION_DENIED");
      const structuredContent = { recipes: [...registry.listRecipes(workspaceId)] };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
        structuredContent,
      };
    } catch (error) { return toolError(error); }
  });

  server.registerTool("exec_recipe", {
    title: "Run controlled workspace recipe",
    description: "Run one locally configured Controlled Recipe. The caller supplies only workspaceId and recipeId; executable, argv, cwd, environment policy, and timeout come from Bridge configuration. This controls invocation shape but does not sandbox the project code it runs. Arbitrary shell input is not supported.",
    inputSchema: z.object({ workspaceId: workspaceIdSchema, recipeId: workspaceRecipeIdSchema }).strict(),
    outputSchema: z.object({
      recipeId: workspaceRecipeIdSchema,
      cwd: z.string(),
      outcome: z.enum(["completed", "failed", "rejected", "timed-out", "output-limit", "aborted"]),
      exitCode: z.number().int().nullable(),
      signal: z.string().nullable(),
      errorCode: z.string().nullable(),
      durationMs: z.number().int().nonnegative(),
      stdoutBytes: z.number().int().nonnegative(),
      stderrBytes: z.number().int().nonnegative(),
      stdout: z.string(),
      stderr: z.string(),
      errorMessage: z.string().nullable(),
      truncated: z.boolean(),
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  }, async ({ workspaceId, recipeId }, extra) => {
    try {
      const workspace = await registry.openWorkspace(workspaceId);
      if (!isWorkspaceWritableMode(workspace.mode)) throw new PathSecurityError("PERMISSION_DENIED");
      const recipe = registry.getRecipe(workspaceId, recipeId);
      const result = await recipes.run(recipeId, recipe, workspace.root, extra.signal);
      const text = [result.stdout, result.stderr].filter(Boolean).join("\n") || `${recipeId}: ${result.outcome}`;
      return {
        ...(result.outcome === "completed" && result.exitCode === 0 ? {} : { isError: true as const }),
        content: [{ type: "text" as const, text }],
        structuredContent: {
          recipeId: result.recipeId,
          cwd: result.cwd,
          outcome: result.outcome,
          exitCode: result.exitCode,
          signal: result.signal,
          errorCode: result.errorCode ?? null,
          durationMs: result.durationMs,
          stdoutBytes: result.stdoutBytes,
          stderrBytes: result.stderrBytes,
          stdout: result.stdout,
          stderr: result.stderr,
          errorMessage: result.errorMessage ?? null,
          truncated: result.truncated,
        },
      };
    } catch (error) { return toolError(error); }
  });

  server.registerTool("exec_command", {
    title: "Run development check",
    description: "Run one configured package script in a configured workspace mode. Only test, build, lint, typecheck, or an explicitly allowed package-script name is accepted; arbitrary shell input is not supported.",
    inputSchema: mcpExecRequestSchema,
    outputSchema: z.object({
      outcome: z.enum(["completed", "failed", "rejected", "timed-out", "output-limit", "aborted"]),
      exitCode: z.number().int().nullable(),
      signal: z.string().nullable(),
      errorCode: z.string().nullable(),
      durationMs: z.number().int().nonnegative(),
      stdoutBytes: z.number().int().nonnegative(),
      stderrBytes: z.number().int().nonnegative(),
      stdout: z.string(),
      stderr: z.string(),
      errorMessage: z.string().nullable(),
      truncated: z.boolean(),
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  }, async (input, extra) => {
    try {
      const { workspaceId, kind, cwd } = input;
      const workspace = await registry.openWorkspace(workspaceId);
      if (!isWorkspaceWritableMode(workspace.mode)) throw new PathSecurityError("PERMISSION_DENIED");
      const commandRequest = kind === "package-script"
        ? { kind, name: input.name, ...(cwd ? { cwd } : {}) }
        : { kind, ...(cwd ? { cwd } : {}) };
      const result = await commands.run(commandRequest, {
        workspaceRoot: workspace.root,
        allowedPackageScripts: workspace.allowedScripts,
      }, extra.signal);
      const text = [result.stdout, result.stderr].filter(Boolean).join("\n") || `${kind}: ${result.outcome}`;
      return {
        ...(result.outcome === "completed" && result.exitCode === 0 ? {} : { isError: true as const }),
        content: [{ type: "text", text }],
        structuredContent: {
          outcome: result.outcome,
          exitCode: result.exitCode,
          signal: result.signal,
          errorCode: result.errorCode ?? null,
          durationMs: result.durationMs,
          stdoutBytes: result.stdoutBytes,
          stderrBytes: result.stderrBytes,
          stdout: result.stdout,
          stderr: result.stderr,
          errorMessage: result.errorMessage ?? null,
          truncated: result.truncated,
        },
      };
    } catch (error) { return toolError(error); }
  });

  server.registerTool("exec_dev_command", {
    title: "Run trusted developer command",
    description: "Run a developer command only in a trusted-dev workspace using the Bridge host's current user context. Supports structured executable+argv or an explicit cmd/PowerShell command. This is trusted host execution, not an OS sandbox; cwd remains workspace-contained and runtime/output limits still apply.",
    inputSchema: trustedDevRequestSchema,
    outputSchema: z.object({
      outcome: z.enum(["completed", "failed", "rejected", "timed-out", "output-limit", "aborted"]),
      exitCode: z.number().int().nullable(),
      signal: z.string().nullable(),
      errorCode: z.string().nullable(),
      durationMs: z.number().int().nonnegative(),
      stdoutBytes: z.number().int().nonnegative(),
      stderrBytes: z.number().int().nonnegative(),
      stdout: z.string(),
      stderr: z.string(),
      errorMessage: z.string().nullable(),
      truncated: z.boolean(),
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  }, async (input, extra) => {
    try {
      const workspace = await registry.openWorkspace(input.workspaceId);
      if (!isTrustedDevMode(workspace.mode)) throw new PathSecurityError("PERMISSION_DENIED");
      const request = input.type === "exec"
        ? {
            type: "exec" as const,
            executable: input.executable!,
            args: input.args ?? [],
            ...(input.cwd ? { cwd: input.cwd } : {}),
            ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
          }
        : {
            type: "shell" as const,
            shell: input.shell!,
            command: input.command!,
            ...(input.cwd ? { cwd: input.cwd } : {}),
            ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
          };
      const result = await trustedDevCommands.run(request, workspace.root, extra.signal);
      const text = [result.stdout, result.stderr].filter(Boolean).join("\n") || `trusted-dev ${input.type}: ${result.outcome}`;
      return {
        ...(result.outcome === "completed" && result.exitCode === 0 ? {} : { isError: true as const }),
        content: [{ type: "text" as const, text }],
        structuredContent: {
          outcome: result.outcome,
          exitCode: result.exitCode,
          signal: result.signal,
          errorCode: result.errorCode ?? null,
          durationMs: result.durationMs,
          stdoutBytes: result.stdoutBytes,
          stderrBytes: result.stderrBytes,
          stdout: result.stdout,
          stderr: result.stderr,
          errorMessage: result.errorMessage ?? null,
          truncated: result.truncated,
        },
      };
    } catch (error) { return toolError(error); }
  });

  server.registerTool("launch_desktop_app", {
    title: "Launch desktop application",
    description: "Launch an application only from a trusted-dev workspace in the Bridge process's current interactive user/session context. The launch is non-elevated, visible on Windows, returns promptly with a PID, and is not owned or automatically terminated by Bridge shutdown.",
    inputSchema: z.object({
      workspaceId: workspaceIdSchema,
      target: z.string().min(1).max(4096),
      args: z.array(z.string().max(16 * 1024)).max(256).default([]),
      cwd: relativePathSchema.optional(),
    }).strict(),
    outputSchema: z.object({
      launchId: z.string().uuid(),
      pid: z.number().int().positive(),
      startedAt: z.string(),
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  }, async ({ workspaceId, target, args, cwd }) => {
    try {
      const workspace = await registry.openWorkspace(workspaceId);
      if (!isTrustedDevMode(workspace.mode)) throw new PathSecurityError("PERMISSION_DENIED");
      const launched = await desktopApps.launch({ target, args, ...(cwd ? { cwd } : {}) }, workspace.root);
      const structuredContent = { ...launched };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
        structuredContent,
      };
    } catch (error) { return toolError(error); }
  });

  return server;
}
