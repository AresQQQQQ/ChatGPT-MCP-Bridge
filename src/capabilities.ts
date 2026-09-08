export const BRIDGE_CAPABILITY_VERSION = 6 as const;
export const CODEX_STATE_VERSION = 4 as const;
export const CODEX_MODULE_MODEL = "configured-temporary-single-binding" as const;
export const CODEX_EXECUTION_TRANSPORT = "desktop-ipc" as const;
export const CODEX_DEFAULT_MODEL = "gpt-5.6-luna" as const;
export const CODEX_DEFAULT_REASONING_EFFORT = "max" as const;

export const BRIDGE_CAPABILITIES = Object.freeze({
  bridgeCapabilityVersion: BRIDGE_CAPABILITY_VERSION,
  codexStateVersion: CODEX_STATE_VERSION,
  codexModuleModel: CODEX_MODULE_MODEL,
  codexExecutionTransport: CODEX_EXECUTION_TRANSPORT,
  codexDefaultModel: CODEX_DEFAULT_MODEL,
  codexDefaultReasoningEffort: CODEX_DEFAULT_REASONING_EFFORT,
});
