import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import type { WorkspaceMcpServerConfig } from "../config.js";
import { LocalMcpRegistry } from "./local-mcp-registry.js";

export const MAX_DOWNSTREAM_RESULT_BYTES = 4 * 1024 * 1024;

export class LocalMcpProxyError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "LocalMcpProxyError";
  }
}

export interface LocalMcpToolSummary {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: unknown;
  readonly outputSchema?: unknown;
  readonly annotations?: unknown;
}

export interface LocalMcpToolListResult extends Record<string, unknown> {
  readonly workspaceId: string;
  readonly serverId: string;
  readonly tools: readonly LocalMcpToolSummary[];
}

export interface LocalMcpToolCallResult extends Record<string, unknown> {
  readonly workspaceId: string;
  readonly serverId: string;
  readonly toolName: string;
  readonly downstreamIsError: boolean;
  readonly content: readonly unknown[];
  readonly structuredContent?: unknown;
}

function safeErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return "request failed";
  const message = error.message.replace(/[\r\n\t\0]/gu, " ").trim();
  return message.length > 300 ? `${message.slice(0, 300)}…` : message || "request failed";
}

function assertResultSize(value: unknown): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new LocalMcpProxyError("Downstream MCP returned a non-serializable result");
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_DOWNSTREAM_RESULT_BYTES) {
    throw new LocalMcpProxyError("Downstream MCP result exceeds the 4 MiB proxy limit");
  }
}

async function withClient<T>(
  registry: LocalMcpRegistry,
  workspaceId: string,
  serverId: string,
  action: (client: Client) => Promise<T>,
  requireLoaded = true,
): Promise<T> {
  let server: WorkspaceMcpServerConfig;
  try {
    server = registry.resolve(workspaceId, serverId, { requireLoaded });
  } catch (error) {
    throw new LocalMcpProxyError(error instanceof Error ? error.message : "Unknown local MCP server");
  }
  const client = new Client({ name: "chatgpt-mcp-bridge-local-proxy", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(server.url));
  try {
    await client.connect(transport as unknown as Parameters<typeof client.connect>[0]);
    return await action(client);
  } catch (error) {
    if (error instanceof LocalMcpProxyError) throw error;
    throw new LocalMcpProxyError(`Local MCP '${serverId}' request failed: ${safeErrorMessage(error)}`);
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function listLocalMcpTools(
  registry: LocalMcpRegistry,
  workspaceId: string,
  serverId: string,
  options: { readonly requireLoaded?: boolean } = {},
): Promise<LocalMcpToolListResult> {
  return withClient(registry, workspaceId, serverId, async (client) => {
    const result = await client.listTools();
    const tools = result.tools.map((tool) => ({
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      inputSchema: tool.inputSchema,
      ...(tool.outputSchema !== undefined ? { outputSchema: tool.outputSchema } : {}),
      ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
    }));
    assertResultSize(tools);
    return { workspaceId, serverId, tools };
  }, options.requireLoaded !== false);
}

export async function callLocalMcpTool(
  registry: LocalMcpRegistry,
  workspaceId: string,
  serverId: string,
  toolName: string,
  args: Readonly<Record<string, unknown>> = {},
): Promise<LocalMcpToolCallResult> {
  return withClient(registry, workspaceId, serverId, async (client) => {
    const result = await client.callTool({ name: toolName, arguments: { ...args } });
    const content = Array.isArray(result.content) ? result.content : [];
    const proxyResult: LocalMcpToolCallResult = {
      workspaceId,
      serverId,
      toolName,
      downstreamIsError: result.isError === true,
      content,
      ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
    };
    assertResultSize(proxyResult);
    return proxyResult;
  });
}
