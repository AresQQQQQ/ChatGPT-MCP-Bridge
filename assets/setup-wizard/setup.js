"use strict";
const $ = id => document.getElementById(id);
let token = location.hash.slice(1) || sessionStorage.getItem("bridge-setup-session") || "";
if (location.hash) {
  sessionStorage.setItem("bridge-setup-session", token);
  history.replaceState(null, "", "/setup");
}
let snapshot;
let submitting = false;
let initialized = false;
let pollTimer;
const request = async (route, body) => {
  const response = await fetch(route, {
    method: body ? "POST" : "GET",
    headers: { Authorization: "Bearer " + token, ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "配置请求失败。");
  return result;
};
function setStatus(text, tone) {
  $("progress-state").textContent = text;
  $("progress-state").className = "state-pill" + (tone ? " " + tone : "");
}
function setBusy(value) {
  submitting = value;
  for (const id of ["tunnel-id", "runtime-key", "health-port", "bridge-port-input", "reuse-client"]) $(id).disabled = value || Boolean(snapshot?.success);
  $("apply").disabled = value || Boolean(snapshot?.success) || Boolean(snapshot?.configurationError);
  $("cancel").disabled = value;
  $("apply").textContent = value ? "正在配置…" : snapshot?.success ? "配置已完成" : "验证并保存配置";
  $("progress-track").hidden = !value;
}
function updateBridgePortDisplay() {
  const selected = $("bridge-port-input").value;
  const shown = selected || String(snapshot?.bridgePort || 3000);
  $("bridge-port").textContent = shown;
  $("port-hint").textContent = "健康检查端口必须与 Bridge 端口 " + shown + " 不同。";
}
function render(state) {
  snapshot = state;
  if (!initialized) {
    $("health-port").value = String(state.defaultHealthPort || 8080);
    $("reuse-client").checked = Boolean(state.reuseClientDefault);
    $("bridge-port-input").value = String(state.bridgePort || 3000);
    initialized = true;
  }
  updateBridgePortDisplay();
  $("reuse-row").hidden = !state.tunnelConfigured;
  $("key-required").textContent = state.hasRuntimeKey ? "可选" : "必填";
  $("key-hint").textContent = state.hasRuntimeKey
    ? "留空保留本机已有密钥；输入新值则更新本机 .env。密钥不会显示在日志中。"
    : "首次配置需要填写 Runtime API key。密钥只写入本机 .env，不会同步到 GitHub。";
  $("mode-title").textContent = state.tunnelConfigured ? "重新配置本机 Tunnel" : "首次配置本机 Tunnel";
  $("mode-description").textContent = state.tunnelConfigured
    ? "会在当前电脑创建独立 profile，保留现有工作区和权限配置。"
    : "向导会初始化 Bridge 默认配置与 Tunnel；所有配置只保存在当前电脑。";
  $("config-warning").hidden = !state.configurationError;
  $("config-warning").textContent = state.configurationError || "";
  $("error-message").hidden = !state.error;
  $("error-message").textContent = state.error || "";
  $("progress-title").textContent = state.progress || "等待配置";
  if (state.running || submitting) setStatus("进行中", "working");
  else if (state.success) setStatus("已完成", "success");
  else if (state.error || state.configurationError) setStatus("需要处理", "failed");
  else setStatus("就绪", "");
  if (state.success) {
    $("progress-detail").textContent = "配置已保存。关闭此窗口后，启动 Bridge 即可使用。";
    $("apply").hidden = true;
    $("cancel").textContent = "完成并关闭";
  } else if (state.running) {
    $("progress-detail").textContent = "请保持窗口打开。向导不会把密钥写入日志或命令行参数。";
  } else {
    $("progress-detail").textContent = "提交后将下载并校验官方客户端，然后初始化本机 profile。失败时原配置会保留。";
    $("apply").hidden = false;
    $("cancel").textContent = "取消";
  }
  setBusy(Boolean(state.running) || submitting);
}
async function refresh() {
  try { render(await request("/api/snapshot")); }
  catch (error) {
    $("error-message").hidden = false;
    $("error-message").textContent = error.message;
    setStatus("连接失败", "failed");
  }
}
$("setup-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (submitting || snapshot?.success) return;
  const tunnelId = $("tunnel-id").value.trim();
  const runtimeKey = $("runtime-key").value;
  const healthPort = Number($("health-port").value);
  const bridgePort = Number($("bridge-port-input").value);
  if (!/^tunnel_[A-Za-z0-9_-]{1,128}$/.test(tunnelId)) {
    $("error-message").hidden = false; $("error-message").textContent = "Tunnel ID 格式无效，应以 tunnel_ 开头。"; return;
  }
  if (!Number.isInteger(bridgePort) || bridgePort < 1 || bridgePort > 65535) {
    $("error-message").hidden = false; $("error-message").textContent = "Bridge 端口须为 1–65535。"; return;
  }
  if (!Number.isInteger(healthPort) || healthPort < 1024 || healthPort > 65535 || healthPort === bridgePort) {
    $("error-message").hidden = false; $("error-message").textContent = "健康端口须为 1024–65535，且不能与 Bridge 端口相同。"; return;
  }
  if (!runtimeKey && !snapshot?.hasRuntimeKey) {
    $("error-message").hidden = false; $("error-message").textContent = "首次配置需要填写 Runtime API key。"; return;
  }
  $("error-message").hidden = true;
  setBusy(true);
  try {
    await request("/api/setup", { tunnelId, runtimeKey, healthPort, bridgePort, reuseClient: $("reuse-client").checked });
    $("runtime-key").value = "";
    await refresh();
  } catch (error) {
    $("runtime-key").value = "";
    $("error-message").hidden = false; $("error-message").textContent = error.message;
    await refresh();
  } finally { setBusy(Boolean(snapshot?.running)); }
});
$("bridge-port-input").addEventListener("input", updateBridgePortDisplay);
$("cancel").addEventListener("click", () => {
  if (snapshot?.running || submitting) return;
  const handler = window.webkit?.messageHandlers?.closeWizard;
  if (handler) handler.postMessage(null);
  else window.close();
});
void refresh();
pollTimer = setInterval(() => { if (!snapshot?.success) void refresh(); }, 500);
window.addEventListener("pagehide", () => clearInterval(pollTimer), { once: true });