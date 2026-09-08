import express, { type ErrorRequestHandler, type Express } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import path from "node:path";

import { BRIDGE_CAPABILITIES } from "../capabilities.js";
import type { BridgeConfig } from "../config.js";
import { CodexTaskManager } from "../codex/codex-tasks.js";
import { WorktreeCheckpointStore } from "../git/worktree-checkpoint.js";
import { buildHttpSecurityPolicy, createMcpSecurityMiddleware } from "./auth.js";
import { createMcpServer } from "../mcp/server.js";
import { LocalMcpRegistry } from "../mcp/local-mcp-registry.js";
import { WorkspaceRegistry } from "../workspaces/workspace-registry.js";

export interface BridgeApp {
  readonly app: Express;
  readonly registry: WorkspaceRegistry;
  readonly localMcpRegistry: LocalMcpRegistry;
  readonly codex?: CodexTaskManager;
  readonly close: () => Promise<void>;
}

export type BridgeHttpLogSink = (stream: "stdout" | "stderr", message: string) => void;

export interface BridgeAppOptions {
  readonly logSink?: BridgeHttpLogSink;
}

function safeLogValue(value: unknown, maxLength = 512): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const cleaned = value.replace(/[\r\n\t\0]/gu, " ");
  return cleaned.length <= maxLength ? cleaned : `${cleaned.slice(0, maxLength)}…`;
}

function describeToolTarget(params: Record<string, unknown> | undefined): string {
  const argumentsValue = params?.arguments;
  if (typeof argumentsValue !== "object" || argumentsValue === null || Array.isArray(argumentsValue)) return "";
  const args = argumentsValue as Record<string, unknown>;
  const workspaceId = safeLogValue(args.workspaceId, 128);
  const pathValue = safeLogValue(args.path);
  const sourcePath = safeLogValue(args.sourcePath);
  const targetPath = safeLogValue(args.targetPath);
  const cwd = safeLogValue(args.cwd);

  const workspace = workspaceId ? ` [${workspaceId}]` : "";
  if (sourcePath || targetPath) {
    return `${workspace} ${sourcePath ?? "?"} -> ${targetPath ?? "?"}`;
  }
  if (pathValue) return `${workspace} ${pathValue}`;
  if (cwd) return `${workspace} cwd=${cwd}`;
  return workspace;
}

function describeMcpRequest(body: unknown): string {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return "MCP request";
  const record = body as Record<string, unknown>;
  const method = typeof record.method === "string" ? record.method : "request";
  if (method !== "tools/call") return `MCP ${method}`;
  const params = typeof record.params === "object" && record.params !== null && !Array.isArray(record.params)
    ? record.params as Record<string, unknown>
    : undefined;
  const toolName = typeof params?.name === "string" ? params.name : "unknown";
  return `MCP tools/call ${toolName}${describeToolTarget(params)}`;
}

export async function createBridgeApp(config: BridgeConfig, options: BridgeAppOptions = {}): Promise<BridgeApp> {
  const securityPolicy = buildHttpSecurityPolicy(config);
  const registry = await WorkspaceRegistry.create(config);
  const codexEnabled = config.workspaces.some((workspace) => workspace.codex?.enabled === true);
  const codex = codexEnabled
    ? new CodexTaskManager({
        config,
        registry,
        stateFile: config.codex?.stateFile ?? path.join(path.dirname(config.configPath), ".mcp-bridge-state", "codex.json"),
      })
    : undefined;
  if (codex) await codex.initialize();
  const app = express();
  const worktreeCheckpoints = new WorktreeCheckpointStore();
  const localMcpRegistry = new LocalMcpRegistry(
    config,
    path.join(path.dirname(config.configPath), ".mcp-bridge-state", "local-mcp.json"),
  );
  await localMcpRegistry.initialize();
  const localMcpStateWarning = localMcpRegistry.consumeStateWarning();
  if (localMcpStateWarning) options.logSink?.("stderr", localMcpStateWarning);
  const activeServers = new Set<ReturnType<typeof createMcpServer>>();
  const mcpPath = config.mcpPath;

  app.get("/health", (_request, response) => {
    response.json({ ok: true, service: "chatgpt-mcp-bridge", capabilities: BRIDGE_CAPABILITIES });
  });

  app.all(mcpPath, createMcpSecurityMiddleware(securityPolicy));
  app.use(express.json({ limit: "2mb" }));

  app.all(mcpPath, async (request, response) => {
    const startedAt = Date.now();
    const description = describeMcpRequest(request.body);
    const isInternalProbe = request.get("x-mcp-bridge-probe") === "status";
    const shouldLogRequest = !isInternalProbe && description !== "MCP initialize";
    if (shouldLogRequest) {
      response.once("finish", () => {
        options.logSink?.(
          response.statusCode >= 500 ? "stderr" : "stdout",
          `${description} -> HTTP ${response.statusCode} (${Date.now() - startedAt}ms)`,
        );
      });
    }
    try {
      const sessionIdHeader = request.headers["mcp-session-id"];
      const sessionId = typeof sessionIdHeader === "string" ? sessionIdHeader : undefined;

      // All tools are request-scoped. Stateless Streamable HTTP prevents
      // Secure MCP Tunnel initialization probes from accumulating unused
      // stateful sessions while remaining compatible with standard clients.
      if (request.method === "POST" && !sessionId) {
        const statelessTransport = new StreamableHTTPServerTransport({
          enableJsonResponse: true,
        });
        const server = createMcpServer(config, registry, codex, worktreeCheckpoints, localMcpRegistry);
        activeServers.add(server);
        try {
          await server.connect(statelessTransport as unknown as Parameters<typeof server.connect>[0]);
          await statelessTransport.handleRequest(request, response, request.body);
        } finally {
          activeServers.delete(server);
          await server.close();
        }
        return;
      }

      response.status(sessionId ? 404 : 400).json({
        error: sessionId ? "Unknown MCP session" : "Expected an MCP POST request",
      });
    } catch (error) {
      if (!response.headersSent) {
        response.status(500).json({ error: "MCP request failed" });
      }
    }
  });

  const safeErrorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
    const status = typeof error === "object" && error !== null && "status" in error
      ? Number(error.status)
      : 500;
    if (status === 413) {
      response.status(413).json({ error: "Request body too large" });
      return;
    }
    if (status >= 400 && status < 500) {
      response.status(400).json({ error: "Invalid request body" });
      return;
    }
    response.status(500).json({ error: "Request failed" });
  };
  app.use(safeErrorHandler);

  return {
    app,
    registry,
    localMcpRegistry,
    ...(codex ? { codex } : {}),
    close: async () => {
      await Promise.all([...activeServers].map((server) => server.close()));
      activeServers.clear();
      await codex?.close();
    },
  };
}
