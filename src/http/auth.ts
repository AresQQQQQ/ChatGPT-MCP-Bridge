import { createHash, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";

import {
  isExactOrigin,
  isLoopbackHost,
  isStrongAuthToken,
  isValidAllowedHost,
  type BridgeConfig,
} from "../config.js";

export interface HttpSecurityPolicy {
  readonly requireAuth: boolean;
  readonly token: string | undefined;
  readonly allowedHosts: ReadonlySet<string>;
  readonly allowedOrigins: ReadonlySet<string>;
}

function normalizeHost(value: string): string {
  return value.trim().toLowerCase().replace(/^\[|\]$/g, "");
}

function formatOriginHost(host: string): string {
  const normalized = normalizeHost(host);
  return normalized.includes(":") ? `[${normalized}]` : normalized;
}

function defaultAllowedHosts(host: string): readonly string[] {
  return isLoopbackHost(host) ? ["127.0.0.1", "localhost", "::1"] : [normalizeHost(host)];
}

function defaultAllowedOrigins(config: Pick<BridgeConfig, "host" | "port" | "allowedHosts">): readonly string[] {
  const hosts = config.allowedHosts ?? defaultAllowedHosts(config.host);
  return hosts.map((host) => `http://${formatOriginHost(host)}:${config.port}`);
}

export function buildHttpSecurityPolicy(config: BridgeConfig): HttpSecurityPolicy {
  const token = config.auth?.token;
  if (token && !isStrongAuthToken(token)) {
    throw new Error("Configured auth token must contain at least 32 bytes");
  }
  if (!isLoopbackHost(config.host) && !token) {
    throw new Error("Non-loopback host requires a configured auth token");
  }

  const configuredHosts = config.allowedHosts ?? defaultAllowedHosts(config.host);
  if (configuredHosts.length === 0 || configuredHosts.some((host) => !isValidAllowedHost(host))) {
    throw new Error("Configured Host allowlist is invalid");
  }
  const configuredOrigins = config.allowedOrigins ?? defaultAllowedOrigins(config);
  if (configuredOrigins.length === 0 || configuredOrigins.some((origin) => !isExactOrigin(origin))) {
    throw new Error("Configured Origin allowlist is invalid");
  }

  return {
    requireAuth: Boolean(token) || !isLoopbackHost(config.host),
    token,
    allowedHosts: new Set(configuredHosts.map(normalizeHost)),
    allowedOrigins: new Set(configuredOrigins),
  };
}

function parseHostHeader(value: string | undefined): string | undefined {
  if (!value || value.trim() !== value || value.length === 0) {
    return undefined;
  }
  if (value.startsWith("[")) {
    const closingBracket = value.indexOf("]");
    if (closingBracket < 0) return undefined;
    const remainder = value.slice(closingBracket + 1);
    if (remainder && !/^:\d+$/.test(remainder)) return undefined;
    return normalizeHost(value.slice(1, closingBracket));
  }

  const firstColon = value.indexOf(":");
  const lastColon = value.lastIndexOf(":");
  if (firstColon !== lastColon) {
    return undefined;
  }
  if (firstColon >= 0) {
    const port = value.slice(firstColon + 1);
    if (!/^\d+$/.test(port)) return undefined;
    return normalizeHost(value.slice(0, firstColon));
  }
  return normalizeHost(value);
}

function hasValidHost(requestHost: string | undefined, policy: HttpSecurityPolicy): boolean {
  const hostname = parseHostHeader(requestHost);
  return hostname !== undefined && policy.allowedHosts.has(hostname);
}

function hasValidOrigin(origin: string | string[] | undefined, policy: HttpSecurityPolicy): boolean {
  if (origin === undefined) return true;
  return typeof origin === "string" && policy.allowedOrigins.has(origin);
}

function tokenDigest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function hasValidBearerToken(authorization: string | string[] | undefined, policy: HttpSecurityPolicy): boolean {
  if (!policy.requireAuth || !policy.token || typeof authorization !== "string") {
    return !policy.requireAuth;
  }
  const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(authorization);
  if (!match) return false;
  const candidate = match[1];
  if (!candidate) return false;
  return timingSafeEqual(tokenDigest(candidate), tokenDigest(policy.token));
}

/** Security checks are intentionally mounted before body parsing and MCP transport handling. */
export function createMcpSecurityMiddleware(policy: HttpSecurityPolicy): RequestHandler {
  return (request, response, next) => {
    if (!hasValidHost(request.headers.host, policy)) {
      response.status(400).json({ error: "Invalid Host" });
      return;
    }
    if (!hasValidOrigin(request.headers.origin, policy)) {
      response.status(403).json({ error: "Invalid Origin" });
      return;
    }
    if (!hasValidBearerToken(request.headers.authorization, policy)) {
      response.setHeader("WWW-Authenticate", "Bearer");
      response.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
  };
}
