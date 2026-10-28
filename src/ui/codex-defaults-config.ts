import { CODEX_DEFAULT_MODEL, CODEX_DEFAULT_REASONING_EFFORT } from "../capabilities.js";
import { CODEX_MODEL_ID_PATTERN, type CodexDefaultEffort } from "../config.js";

const EFFORTS = new Set<CodexDefaultEffort>(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);

export interface CodexDefaultSettings {
  readonly defaultModel: string;
  readonly defaultEffort: CodexDefaultEffort;
}

export function getCodexDefaultSettings(config: Record<string, unknown>): CodexDefaultSettings {
  const codex = config.codex && typeof config.codex === "object" && !Array.isArray(config.codex)
    ? config.codex as Record<string, unknown>
    : {};
  return {
    defaultModel: typeof codex.defaultModel === "string" ? codex.defaultModel : CODEX_DEFAULT_MODEL,
    defaultEffort: typeof codex.defaultEffort === "string" && EFFORTS.has(codex.defaultEffort as CodexDefaultEffort)
      ? codex.defaultEffort as CodexDefaultEffort : CODEX_DEFAULT_REASONING_EFFORT,
  };
}

export function validateCodexDefaultSettings(requested: CodexDefaultSettings): CodexDefaultSettings {
  if (typeof requested.defaultModel !== "string") throw new Error("模型 ID 无效");
  const model = requested.defaultModel.trim();
  if (!CODEX_MODEL_ID_PATTERN.test(model)) throw new Error("模型 ID 无效（不能包含空格或控制字符，最多 256 字符）");
  if (!EFFORTS.has(requested.defaultEffort)) throw new Error("推理等级无效");

  return { defaultModel: model, defaultEffort: requested.defaultEffort };
}

export function withCodexDefaultSettings(
  config: Record<string, unknown>,
  requested: CodexDefaultSettings,
): Record<string, unknown> {
  const settings = validateCodexDefaultSettings(requested);
  if (config.codex !== undefined && (typeof config.codex !== "object" || config.codex === null || Array.isArray(config.codex))) {
    throw new Error("现有 Codex 配置格式无效");
  }
  const codex = config.codex as Record<string, unknown> | undefined;
  return {
    ...config,
    codex: { ...codex, defaultModel: settings.defaultModel, defaultEffort: settings.defaultEffort },
  };
}
