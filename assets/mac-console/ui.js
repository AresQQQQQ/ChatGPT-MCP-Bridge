"use strict";
const $ = id => document.getElementById(id);
const escape = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
const modes = { readonly:"只读", workspace:"普通工作区", "trusted-dev":"可信开发", handoff:"交接模式" };
const modeClasses = { readonly:"mode-readonly", workspace:"mode-workspace", "trusted-dev":"mode-trusted-dev", handoff:"mode-handoff" };
const lifecycleLabels = { stopped:"已停止", starting:"正在启动", running:"运行中", stopping:"正在停止", error:"服务异常" };
const tokenKey = "bridge-ui-session";
let credential = location.hash.slice(1) || sessionStorage.getItem(tokenKey) || "";
if (location.hash) { sessionStorage.setItem(tokenKey, credential); history.replaceState(null, "", "/"); }
let snapshot, selected, selectedModule, draft, editRevision, lastSelection, activeTab = "details", localBusy = false;
let chainSignature = "", treeSignature = "", detailsSignature = "", mcpsSignature = "", globalMcpsSignature = "";
let sourceFilter = "all", clearedThrough = "", visibleLogs = [], logSignature = "", toastTimer, expired = false;
let setupOpen = false, setupInitialized = false, lastSetupSuccess = false, settingsOpen = false, settingsInitialized = false, globalMcpOpen = false, codexDefaultsOpen = false, codexDefaultsInitialized = false, sshHostsOpen = false, sshHostFormOpen = false, sshHostBusy = false, sshHostEditing = undefined, sshHosts = [], sshHostsLoaded = false, lastCommandError = "";

function toast(message) { $("toast").textContent = message; $("toast").hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $("toast").hidden = true, 4200); }
async function request(route, body) {
  const response = await fetch(route, { method: body ? "POST" : "GET", headers: { Authorization:`Bearer ${credential}`, ...(body ? {"Content-Type":"application/json"} : {}) }, ...(body ? {body:JSON.stringify(body)} : {}) });
  const result = await response.json();
  if (!response.ok) { if (response.status === 401) expired = true; throw new Error(result.error || "操作失败"); }
  return result;
}
async function command(action, extra = {}) {
  if (localBusy || snapshot?.busy) return;
  const state = snapshot?.status.state;
  if (action === "start" && snapshot?.connectionSetup?.ready === false) { toast("连接配置尚未完成，请先打开连接向导。"); setupOpen = true; renderConnectionSetup(); return false; }
  if (action === "save-api-port-settings" && state !== "stopped") { toast("请先停止 Bridge，再保存连接设置。"); return false; }
  if (action === "connection-setup" && draft) { toast("请先保存或取消项目编辑。"); return; }
  if (action === "start" && !["stopped", "error"].includes(state)) return;
  if (action === "stop" && !["running", "error"].includes(state)) return;
  if (action === "restart" && state !== "running") return;
  if (draft && ["start", "restart"].includes(action)) { toast("请先保存或取消项目编辑"); return; }
  localBusy = true; updateButtons();
  try { await request("/api/action", {action, ...extra}); toast({start:"Bridge 与 Tunnel 已启动",stop:"服务已停止",restart:"服务已重新启动","refresh-codex":"绑定状态已刷新","unbind-codex":"已解除绑定","local-mcp-load":"本地 MCP 已加载","local-mcp-unload":"本地 MCP 已卸载","local-mcp-probe":"本地 MCP 检测完成"}[action] || "操作完成"); await refresh(); }
  catch (error) { toast(error.message); }
  finally { localBusy = false; updateButtons(); }
}
async function confirmAction(title, message) {
  $("confirm-title").textContent = title; $("confirm-message").textContent = message;
  const dialog = $("confirm-dialog"); dialog.returnValue = "cancel"; dialog.showModal();
  return new Promise(resolve => dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), {once:true}));
}
function currentWorkspaces() { return draft || snapshot?.workspaces || []; }
function currentWorkspace() { return currentWorkspaces().find(w => w.id === selected); }
function moduleForSelection() { return snapshot?.codexBindings.find(m => m.workspaceId === selected && m.moduleId === selectedModule); }
function select(workspaceId, moduleId) { selected = workspaceId; selectedModule = moduleId; lastSelection = undefined; renderTree(); renderInspector(); }
function renderChain() {
  const s = snapshot.status, c = snapshot.codexStatus;
  const signature = JSON.stringify([s, c]); if (signature === chainSignature) return; chainSignature = signature;
  const connected = s.tunnel === "connected";
  const nodes = [
    ["chatgpt", "ChatGPT", connected ? "Tunnel 就绪；插件状态未知" : "等待隧道", connected ? "good" : ""],
    ["secure-tunnel", "Secure Tunnel", connected ? "已连接" : s.tunnel === "error" ? "连接异常" : "未连接", connected ? "good" : s.tunnel === "error" ? "bad" : ""],
    ["mcp", "MCP", s.mcp === "available" ? "工具服务可用" : "未运行", s.mcp === "available" ? "good" : ""],
    ["mcp-bridge", "MCP Bridge", s.bridge === "running" ? "运行中" : s.state === "error" ? "服务异常" : "已停止", s.bridge === "running" ? "good" : s.state === "error" ? "bad" : ""],
    ["codex-desktop", "Codex Desktop", c.ipcConnected ? "IPC 已连接" : c.enabled ? "等待 Desktop" : "未配置", c.ipcConnected ? "good" : ""],
  ];
  $("chain").innerHTML = nodes.map(([icon, title, state, tone], i) => `${i ? '<span class="chain-arrow" aria-hidden="true">›</span>' : ""}<div class="chain-node"><img src="/icons/${icon}.png" alt=""><div><h3>${title}</h3><p><i class="dot ${tone}"></i>${state}</p></div></div>`).join("");
  $("lifecycle").textContent = lifecycleLabels[s.state] || s.state;
  $("lifecycle").className = "badge" + (s.state === "running" ? " good" : ["starting","stopping"].includes(s.state) ? " warn" : "");
  const codexReady = c.enabled === true && c.ipcConnected === true;
  let overall = { label:"已停止", tone:"" };
  if (s.state === "error") overall = { label:"服务异常", tone:"bad" };
  else if (s.state === "starting") overall = { label:"启动中", tone:"warn" };
  else if (s.state === "stopping") overall = { label:"停止中", tone:"warn" };
  else if (s.state === "running" && s.mcp === "available" && s.tunnel === "connected" && codexReady) overall = { label:"运行正常", tone:"good" };
  else if (s.state === "running" && s.mcp === "available" && s.tunnel === "connected") overall = { label:"Bridge 正常 · Codex 未连接", tone:"warn" };
  else if (s.state === "running") overall = { label:"运行中 · 链路不完整", tone:"warn" };
  $("overall-health").textContent = overall.label;
  $("overall-health").className = `badge ${overall.tone}`.trim();
  $("runtime-meta").textContent = [s.pid ? `PID ${s.pid}` : "", s.port ? `端口 ${s.port}` : "", s.startedAt ? new Date(s.startedAt).toLocaleTimeString("zh-CN",{hour12:false})+" 启动" : ""].filter(Boolean).join(" · ");
  $("service-error").hidden = !s.error; $("service-error").textContent = s.error || "";
}
function renderTree() {
  const filter = $("workspace-search").value.toLowerCase();
  const rows = currentWorkspaces().map(w => {
    const modules = (snapshot.codexBindings || []).filter(m => m.workspaceId === w.id);
    const matches = w.id.toLowerCase().includes(filter) || modules.some(m => m.displayName.toLowerCase().includes(filter));
    if (!matches) return "";
    return `<div class="tree-group"><button class="tree-row ${selected === w.id && !selectedModule ? "selected" : ""}" data-workspace="${escape(w.id)}" aria-label="项目 ${escape(w.id)}" aria-current="${selected === w.id && !selectedModule ? "true" : "false"}"><span class="tree-glyph" aria-hidden="true">▱</span><span class="label">${escape(w.id)}</span><span class="small ${modeClasses[w.mode] || "mode-workspace"}">${escape(modes[w.mode])}</span><span class="small module-count" title="${modules.length} Codex Modules">${modules.length}</span></button>${modules.map(m => `<button class="tree-row module-row ${selected === w.id && selectedModule === m.moduleId ? "selected" : ""}" data-workspace="${escape(w.id)}" data-module="${escape(m.moduleId)}"><span class="tree-glyph" aria-hidden="true">${m.moduleKind === "configured" ? "◇" : "◌"}</span><span class="label">${escape(m.displayName)}</span><i class="dot ${m.bindingStatus === "bound" ? "good" : ""}"></i></button>`).join("")}</div>`;
  }).join("");
  if (rows === treeSignature) return; treeSignature = rows;
  $("tree").innerHTML = rows || '<div class="tree-empty">没有匹配的项目</div>';
  $("tree").querySelectorAll("[data-workspace]").forEach(button => button.addEventListener("click", () => select(button.dataset.workspace, button.dataset.module)));
  $("workspace-count").textContent = `${currentWorkspaces().length} 个项目`;
}
function renderInspector(force = false) {
  const w = currentWorkspace(); if (!w) return;
  const m = moduleForSelection();
  $("selection-title").textContent = m ? m.displayName : w.id;
  $("selection-kind").textContent = m ? (m.moduleKind === "configured" ? "长期 MODULE" : "临时 MODULE") : "WORKSPACE";
  $("selection-subtitle").textContent = m ? "Codex 对话与当前绑定" : draft ? "编辑项目配置 · 尚未保存" : "本地项目与访问权限";
  $("selection-mode").textContent = m ? (m.bindingStatus === "bound" ? "已绑定" : "未绑定") : modes[w.mode];
  $("selection-mode").className = "badge" + (m?.bindingStatus === "bound" ? " good" : "");
  const serverCount = snapshot.localMcpServers.filter(s => s.workspaceId === w.id).length;
  $("mcp-count").textContent = String(serverCount);
  $("details-tab").textContent = m ? "Module 详情" : "项目详情";
  const key = `${selected}:${selectedModule || ""}`;
  const signature = JSON.stringify([!!draft, w, m, snapshot.status.state, snapshot.codexStatus, snapshot.codexBindings.length]);
  if (force || key !== lastSelection || (!draft && signature !== detailsSignature)) {
    detailsSignature = signature;
    if (m) renderModule(w, m);
    else if (draft) renderEdit(w);
    else renderProject(w);
    lastSelection = key;
  }
  renderMcps(w); updateTabs(); updateButtons();
}
function renderProject(w) {
  const count = snapshot.codexBindings.filter(m => m.workspaceId === w.id).length;
  $("details").innerHTML = `<div class="detail-heading"><h3>项目配置</h3><button id="edit" data-requires-stopped>编辑配置</button></div><dl class="metadata"><dt>Workspace ID</dt><dd>${escape(w.id)}</dd><dt>本地路径</dt><dd class="mono">${escape(w.root)}</dd><dt>权限模式</dt><dd>${escape(modes[w.mode])} <span class="mono">${escape(w.mode)}</span></dd><dt>Codex Modules</dt><dd>${count} 个${snapshot.codexStatus.enabled ? "" : " · 未启用 Codex"}</dd></dl><p class="detail-note">${snapshot.status.state === "stopped" ? "停止状态下可编辑项目 ID、文件夹及权限，其他配置会保留。" : "服务运行中。修改项目配置前，请先停止 Bridge 与 Tunnel。"}</p>`;
  $("edit").addEventListener("click", () => beginEdit());
}
function beginEdit() {
  if (snapshot.status.state !== "stopped" || localBusy) return;
  draft = snapshot.workspaces.map(w => ({...w})); editRevision = snapshot.revision; selectedModule = undefined;
  renderInspector(true); renderTree();
}
function renderEdit(w) {
  $("details").innerHTML = `<div class="detail-heading"><h3>编辑项目配置</h3><span class="pending-note">未保存</span></div><div class="edit-grid"><label for="project-id">Workspace ID</label><input id="project-id" value="${escape(w.id)}" autocomplete="off" spellcheck="false"><label for="project-root">本地路径</label><div class="path-edit"><input id="project-root" value="${escape(w.root)}" placeholder="选择本机项目文件夹" spellcheck="false"><button id="pick-folder">选择…</button></div><label for="project-mode">权限模式</label><select id="project-mode">${Object.entries(modes).map(([value,label])=>`<option value="${value}" ${w.mode===value?"selected":""}>${label}（${value}）</option>`).join("")}</select></div><div class="edit-actions"><button id="remove-workspace" class="danger" ${draft.length < 2 ? "disabled" : ""}>删除项目</button><div><button id="cancel-edit">取消</button><button id="save-config" class="primary">保存配置</button></div></div><p class="detail-note">trusted-dev 会以当前 Mac 用户身份执行开发命令。删除项目只移除配置，不删除本机文件。</p>`;
  $("project-id").addEventListener("input", event => { w.id = event.target.value; selected = w.id; lastSelection = `${selected}:`; $("selection-title").textContent = w.id || "新项目"; renderTree(); });
  $("project-root").addEventListener("input", event => w.root = event.target.value);
  $("project-mode").addEventListener("change", event => { w.mode = event.target.value; $("selection-mode").textContent = modes[w.mode]; renderTree(); });
  $("pick-folder").addEventListener("click", async () => {
    const picker = window.webkit?.messageHandlers?.chooseFolder;
    if (!picker) { toast("浏览器模式请直接填写绝对路径；原生应用支持文件夹选择器"); return; }
    try { const root = await picker.postMessage(w.root); if (root) { w.root = root; $("project-root").value = root; } } catch { toast("无法打开文件夹选择器"); }
  });
  $("cancel-edit").addEventListener("click", () => { draft = undefined; selected = snapshot.workspaces.some(w=>w.id===selected) ? selected : snapshot.workspaces[0].id; renderInspector(true); renderTree(); });
  $("save-config").addEventListener("click", saveConfig);
  $("remove-workspace").addEventListener("click", async () => {
    if (draft.length < 2) return;
    if (await confirmAction("移除项目配置？", `将移除 ${w.id} 的工作区配置，本机项目文件会保留。保存配置后生效。`)) {
      draft = draft.filter(item=>item!==w); selected=draft[0].id; renderInspector(true); renderTree();
    }
  });
}
async function saveConfig() {
  if (!draft || localBusy || snapshot.status.state !== "stopped") return;
  if (draft.some(w=>!w.id.trim() || !w.root.trim())) { toast("请填写项目 ID 和本地文件夹路径"); return; }
  localBusy=true; updateButtons();
  try {
    await request("/api/action", {action:"save-config",revision:editRevision,workspaces:draft});
    draft=undefined; toast("项目配置已保存"); await refresh();
  } catch(error) {toast(error.message);}
  finally {localBusy=false; updateButtons();}
}
function renderModule(w, m) {
  $("details").innerHTML = `<div class="detail-heading"><h3>Codex 绑定</h3><span class="badge">${m.moduleKind === "configured" ? "长期" : "临时"}</span></div><dl class="metadata"><dt>Module ID</dt><dd class="mono">${escape(m.moduleId)}</dd><dt>绑定状态</dt><dd>${m.bindingStatus === "bound" ? "已绑定" : "未绑定"}</dd><dt>Codex Thread</dt><dd>${escape(m.threadName || "—")}</dd><dt>Thread ID</dt><dd class="mono">${escape(m.threadId || "—")}</dd><dt>Desktop Owner</dt><dd>${m.ownerPresent ? "已接管" : "未接管"}</dd></dl><div class="edit-actions"><button id="refresh-codex">刷新绑定</button><button id="unbind-codex" class="danger" ${m.bindingStatus !== "bound" ? "disabled" : ""}>解除绑定</button></div><p class="detail-note">解除绑定只清除 Bridge 的关联，保留 Codex 中的对话。</p>`;
  $("refresh-codex").addEventListener("click",()=>command("refresh-codex",{workspaceId:w.id}));
  $("unbind-codex").addEventListener("click",async()=>{if(await confirmAction("解除 Module 绑定？",`${m.displayName} 与当前 Codex 对话的关联将被移除，对话会保留。`))await command("unbind-codex",{workspaceId:w.id,moduleId:m.moduleId});});
}
function renderMcps(w) {
  const servers = snapshot.localMcpServers.filter(s=>s.workspaceId===w.id);
  const signature = JSON.stringify([servers, w.id, snapshot.status.state, localBusy, snapshot.busy]); if (signature === mcpsSignature) return; mcpsSignature = signature;
  $("mcps").innerHTML = servers.length ? servers.map(s=>`<div class="mcp-card"><div class="mcp-heading"><h3>${escape(s.serverId)}</h3><span class="badge ${s.loaded?"good":""}">${s.loaded?"已加载":"未加载"}</span></div><p class="mono">${escape(s.url)}</p><div class="mcp-actions"><button data-mcp="local-mcp-probe" data-server="${escape(s.serverId)}">检测</button><button data-mcp="${s.loaded?"local-mcp-unload":"local-mcp-load"}" data-server="${escape(s.serverId)}" class="${s.loaded?"danger":"primary"}">${s.loaded?"卸载":"加载"}</button><span>${s.probeStatus==="available"?`${s.toolCount || 0} tools · ${s.latencyMs || 0}ms`:s.probeStatus==="unavailable"?"检测失败":"尚未检测"}</span></div>${s.probeError?`<p>${escape(s.probeError)}</p>`:""}</div>`).join("") : '<div class="empty-state"><span aria-hidden="true">⊞</span><h3>还没有本地 MCP</h3><p>在项目的 mcpServers 配置中添加回环服务地址。<br>配置完成后启动 Bridge，即可在这里检测与管理。</p></div>';
  $("mcps").querySelectorAll("[data-mcp]").forEach(button=>{button.disabled=snapshot.status.state!=="running"||localBusy||snapshot.busy;button.addEventListener("click",()=>command(button.dataset.mcp,{workspaceId:w.id,serverId:button.dataset.server}));});
}
function renderGlobalMcps() {
  if (!snapshot) return;
  const servers = [...(snapshot.localMcpServers || [])];
  const loadedCount = servers.filter(server => server.loaded).length;
  const workspaceIds = new Set(servers.map(server => server.workspaceId));
  $("global-mcp-count").textContent = `${loadedCount}/${servers.length}`;
  $("global-mcp-count").title = `${loadedCount} 个已加载，${servers.length} 个已配置`;
  $("global-mcp-summary").textContent = servers.length
    ? `已加载 ${loadedCount} / 已配置 ${servers.length} · 涉及 ${workspaceIds.size} 个工作区`
    : "所有工作区目前都没有配置本地 MCP。";
  const dialog = $("global-mcp-dialog");
  if (globalMcpOpen && !dialog.open) dialog.showModal();
  if (!globalMcpOpen && dialog.open) dialog.close();
  const signature = JSON.stringify([servers, snapshot.workspaces.map(workspace => workspace.id), snapshot.status.state, localBusy, snapshot.busy]);
  if (signature === globalMcpsSignature) return;
  globalMcpsSignature = signature;
  const workspaces = new Map(snapshot.workspaces.map(workspace => [workspace.id, workspace]));
  $("global-mcp-list").innerHTML = servers.length ? servers.map(server => {
    const loaded = server.loaded === true;
    const running = snapshot.status.state === "running";
    const probe = server.probeStatus || "unknown";
    const stateText = !running ? "Bridge 已停止" : probe === "available" ? "可用" : probe === "unavailable" ? "不可用" : "尚未检测";
    const stateClass = running && probe === "available" ? "good" : running && probe === "unavailable" ? "bad" : "";
    const detail = probe === "available"
      ? `${server.toolCount ?? 0} tools · ${server.latencyMs ?? 0}ms`
      : probe === "unavailable" ? (server.probeError || "检测失败") : "检测后显示工具数量与延迟";
    return `<article class="global-mcp-card">
      <div class="global-mcp-card-heading"><div><p class="global-mcp-workspace">${escape(workspaces.get(server.workspaceId)?.id || server.workspaceId)}</p><h3>${escape(server.serverId)}</h3></div><span class="badge ${loaded ? "good" : ""}">${loaded ? "已加载" : "未加载"}</span></div>
      <p class="mono global-mcp-url">${escape(server.url)}</p>
      <div class="global-mcp-card-footer"><span class="global-mcp-probe ${stateClass}"><i class="dot ${stateClass}"></i>${escape(stateText)} <small>${escape(detail)}</small></span><div class="mcp-actions"><button data-global-mcp="local-mcp-probe" data-workspace="${escape(server.workspaceId)}" data-server="${escape(server.serverId)}">检测</button><button data-global-mcp="${loaded ? "local-mcp-unload" : "local-mcp-load"}" data-workspace="${escape(server.workspaceId)}" data-server="${escape(server.serverId)}" class="${loaded ? "danger" : "primary"}">${loaded ? "卸载" : "加载"}</button></div></div>
      ${probe === "unavailable" && server.probeError ? `<p class="global-mcp-error">${escape(server.probeError)}</p>` : ""}
    </article>`;
  }).join("") : '<div class="empty-state"><span aria-hidden="true">⊞</span><h3>尚未配置本地 MCP</h3><p>此处会汇总所有工作区的 MCP。请先在对应工作区的 mcpServers 中添加服务地址。</p></div>';
  $("global-mcp-list").querySelectorAll("[data-global-mcp]").forEach(button => {
    button.disabled = snapshot.status.state !== "running" || localBusy || snapshot.busy;
    button.addEventListener("click", () => command(button.dataset.globalMcp, {workspaceId:button.dataset.workspace, serverId:button.dataset.server}));
  });
}
function updateTabs() { $("details").hidden=activeTab!=="details";$("mcps").hidden=activeTab!=="mcps";$("details-tab").setAttribute("aria-selected",String(activeTab==="details"));$("mcps-tab").setAttribute("aria-selected",String(activeTab==="mcps")); }
function updateButtons() {
  const s=snapshot?.status.state || "stopped",busy=localBusy||snapshot?.busy;
  $("start").disabled=expired||busy||!!draft||snapshot?.connectionSetup?.ready===false||!["stopped","error"].includes(s);
  $("start").textContent=s==="starting"?"正在启动…":"▶ 启动服务";
  $("stop").disabled=expired||busy||!["running","error"].includes(s);
  $("restart").disabled=expired||busy||!!draft||s!=="running";
  $("add").disabled=expired||busy||s!=="stopped";
  document.querySelectorAll("[data-requires-stopped]").forEach(button=>button.disabled=busy||s!=="stopped");
  for(const name of ["save-config","cancel-edit","pick-folder","project-id","project-root","project-mode"])if($(name))$(name).disabled=busy||s!=="stopped";
  if($("remove-workspace"))$("remove-workspace").disabled=busy||s!=="stopped"||draft?.length<2;
  renderGlobalMcps();renderCodexDefaults();
  $("footer-status").textContent=expired?"会话已过期，请重新打开应用":draft&&snapshot?.revision!==editRevision?"配置已在外部变化；取消编辑后重新载入":draft?"项目配置有未保存的修改":busy?"正在执行操作…":s==="running"?"服务运行中 · 状态实时更新":"本机控制台已就绪";
}
function logLevel(log) {
  const message = String(log.message || "");
  let match = message.match(/"level"\s*:\s*"(TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL)"/i);
  if (match) return match[1].toUpperCase();
  match = message.match(/(?:^|[\[\s])(WARN|WARNING|ERROR|FATAL|DEBUG|INFO)(?:\]|:|\s)/i);
  if (match) return match[1].toUpperCase();
  return log.stream === "stderr" ? "ERROR" : "INFO";
}
function logLevelLabel(log) {
  const level = logLevel(log);
  return ({TRACE:"调试", DEBUG:"调试", INFO:"信息", WARN:"警告", WARNING:"警告", ERROR:"错误", FATAL:"严重错误"})[level] || "信息";
}
function logTone(log) {
  const level = logLevel(log);
  if (["ERROR", "FATAL"].includes(level)) return "error";
  if (["WARN", "WARNING"].includes(level)) return "warn";
  if (["DEBUG", "TRACE"].includes(level)) return "debug";
  return "info";
}
function renderLogs() {
  const filter=$("log-search").value.toLowerCase();
  visibleLogs=snapshot.logs.filter(log=>log.timestamp>clearedThrough&&(sourceFilter==="all"||log.source===sourceFilter)&&log.message.toLowerCase().includes(filter));
  const signature=JSON.stringify(visibleLogs);if(signature===logSignature)return;logSignature=signature;
  $("log-count").textContent=`${visibleLogs.length} 条`;$("log-empty").hidden=visibleLogs.length>0;
  $("log-lines").replaceChildren(...visibleLogs.map(log=>{
    const row=document.createElement("div");row.className=`log-row ${log.stream} level-${logTone(log)}`;
    const time=document.createElement("span");time.className="log-time";time.textContent=new Date(log.timestamp).toLocaleTimeString("zh-CN",{hour12:false});
    const source=document.createElement("span");source.className="log-source";source.textContent=log.source;
    const level=document.createElement("span");level.className="log-level";level.textContent=logLevelLabel(log);
    const message=document.createElement("span");message.className="log-message";message.textContent=log.message;
    row.append(time,source,level,message);return row;
  }));
  if($("follow").checked)$("log-scroll").scrollTop=$("log-scroll").scrollHeight;
}
function renderConnectionSetup() {
  const state = snapshot?.connectionSetup;
  if (!state) return;
  const missing = state.missingItems || [];
  const incomplete = !state.ready;
  $("connection-setup-banner").hidden = !incomplete;
  $("setup-banner-title").textContent = state.configurationError ? "本机配置需要修复" : incomplete ? "连接配置尚未完成" : "连接配置完整";
  $("setup-banner-summary").textContent = state.configurationError || (missing.length ? "尚缺少：" + missing.join("、") : "连接参数已保存，Tunnel profile 已就绪。");
  const dialog = $("connection-setup-dialog");
  if (setupOpen && !dialog.open) dialog.showModal();
  if (!setupOpen && dialog.open) dialog.close();
  if (!setupInitialized) {
    $("setup-tunnel-id").value = state.tunnelId || "";
    $("setup-runtime-key").value = "";
    setupInitialized = true;
  }
  $("setup-tunnel-id-field").hidden = Boolean(state.hasTunnelId || state.legacyTunnelIdUnknown);
  $("setup-tunnel-id-locked").hidden = !(state.hasTunnelId || state.legacyTunnelIdUnknown);
  $("setup-tunnel-id-readonly").textContent = state.tunnelId || (state.legacyTunnelIdUnknown ? "旧版 profile 可继续使用；Tunnel ID 未记录。需要重新绑定时请前往设置。" : "");
  $("setup-runtime-key-field").hidden = Boolean(state.hasRuntimeKey);
  $("setup-runtime-key-locked").hidden = !state.hasRuntimeKey;
  $("setup-key-hint").textContent = state.legacyTunnelIdUnknown ? "检测到旧版 Tunnel profile，原连接可继续使用；如需绑定新的 Tunnel ID，请前往设置。" : state.hasRuntimeKey || state.hasTunnelId
    ? "已保存的参数只读显示；请填写缺失项。需要修改已保存的值，请前往「设置 → 连接设置」。"
    : "首次填写会使用统一连接配置保存接口。Runtime API key 仅保存在本机 .env。";
  $("setup-error").hidden = !state.error;
  $("setup-error").textContent = state.error || "";
  $("setup-progress-title").textContent = state.progress || "等待配置";
  const running = Boolean(state.running);
  $("setup-progress-state").textContent = running ? "进行中" : state.ready ? "已完成" : state.error || state.configurationError ? "需要处理" : "待初始化";
  $("setup-progress-state").className = "badge" + (running ? " warn" : state.ready ? " good" : state.error || state.configurationError ? " bad" : "");
  $("setup-progress-track").hidden = !running;
  $("setup-progress-detail").textContent = running
    ? "连接参数已保存，正在准备或验证 Tunnel profile。"
    : state.ready ? "本机 Tunnel profile 已就绪。ChatGPT 插件仍需单独创建；请按上方第 3 步启动服务并完成插件配置。修改本机参数请前往设置。" : "参数保存后会安装或复用 Tunnel Client，并初始化本机 profile；失败时已保存的参数仍会保留。";
  const busy = running || localBusy || snapshot.busy || snapshot.status.state !== "stopped";
  $("setup-tunnel-id").disabled = busy || Boolean(state.hasTunnelId);
  $("setup-runtime-key").disabled = busy || Boolean(state.hasRuntimeKey);
  $("setup-submit").textContent = state.ready ? "已完成" : state.hasTunnelId && state.hasRuntimeKey ? "继续初始化" : "保存并初始化";
  $("setup-submit").disabled = busy || Boolean(state.configurationError) || Boolean(state.ready);
  $("setup-cancel").disabled = running || localBusy || Boolean(snapshot.busy);
  if (state.success && !lastSetupSuccess) {
    $("setup-runtime-key").value = "";
    toast("本机 Tunnel 已配置；还需在 ChatGPT Plugins 创建或确认插件。");
  }
  lastSetupSuccess = Boolean(state.success);
}
function renderApiPortSettings() {
  const state = snapshot?.connectionSetup;
  if (!state) return;
  if (!settingsInitialized) {
    $("settings-tunnel-id").value = state.tunnelId || "";
    $("settings-bridge-port").value = String(state.bridgePort || 3000);
    $("settings-health-port").value = String(state.defaultHealthPort || 8080);
    $("settings-runtime-key").value = "";
    settingsInitialized = true;
  }
  const dialog = $("api-port-dialog");
  if (settingsOpen && !dialog.open) dialog.showModal();
  if (!settingsOpen && dialog.open) dialog.close();
  $("api-port-hint").textContent = state.legacyTunnelIdUnknown ? "当前旧版 profile 可继续使用；Tunnel ID 未记录。若在此填写新 ID，保存后会重新初始化 profile。" : state.tunnelConfigured && !state.tunnelProfileMatchesId
    ? "Tunnel ID 与当前 profile 不一致；保存新的 Tunnel ID 会重新初始化 profile。"
    : "修改连接参数前请先停止 Bridge。Tunnel ID 或端口变化时，系统会同步更新 Tunnel profile。";
  const busy = localBusy || snapshot.busy || snapshot.status.state !== "stopped";
  for (const id of ["settings-runtime-key", "settings-tunnel-id", "settings-bridge-port", "settings-health-port"]) $(id).disabled = busy;
  $("settings-api-port-submit").disabled = busy;
}
function renderCodexDefaults() {
  if (!snapshot) return;
  const dialog = $("codex-defaults-dialog");
  if (codexDefaultsOpen && !dialog.open) dialog.showModal();
  if (!codexDefaultsOpen && dialog.open) dialog.close();
  if (!codexDefaultsInitialized) {
    $("codex-default-model").value = snapshot.codexDefaults?.defaultModel || "";
    $("codex-default-effort").value = snapshot.codexDefaults?.defaultEffort || "medium";
    codexDefaultsInitialized = true;
  }
  const busy = localBusy || snapshot.busy || snapshot.status.state !== "stopped";
  $("codex-default-model").disabled = busy;
  $("codex-default-effort").disabled = busy;
  $("codex-defaults-save").disabled = busy;
  $("codex-defaults-hint").textContent = snapshot.status.state !== "stopped"
    ? "请先停止 Bridge，再修改默认值。"
    : busy ? "正在执行操作…" : "保存时会检查配置版本，避免覆盖其他程序的并发修改。";
}
function renderSshHosts() {
  const dialog = $("ssh-hosts-dialog");
  if (!sshHostsOpen) {
    if (dialog.open) dialog.close();
    return;
  }
  if (!dialog.open) dialog.showModal();
  const trusted = snapshot?.workspaces?.some(workspace => workspace.mode === "trusted-dev") === true;
  $("ssh-host-count").textContent = sshHostsLoaded ? String(sshHosts.length) : "›";
  $("settings-ssh-summary").textContent = !trusted
    ? "需要至少一个 trusted-dev 工作区"
    : sshHostsLoaded ? sshHosts.length + " 个已保存主机 · 密码保存在本机 Keychain" : "密码安全保存在本机 Keychain";
  $("ssh-host-add").disabled = !trusted || sshHostBusy;
  $("ssh-hosts-summary").textContent = !trusted
    ? "SSH 主机管理需要至少一个 trusted-dev 工作区。请先在项目设置中调整权限模式。"
    : sshHostsLoaded ? sshHosts.length + " 个全局 SSH 主机 · 密码不会写入主机元数据" : "正在读取主机列表…";
  $("ssh-host-list").hidden = sshHostFormOpen;
  $("ssh-host-list-actions").hidden = sshHostFormOpen;
  $("ssh-host-form").hidden = !sshHostFormOpen;
  $("ssh-host-list").innerHTML = sshHosts.length ? sshHosts.map(host => {
    const credential = host.credentialAvailable ? "凭据已保存" : "未检测到已保存密码";
    const tone = host.credentialAvailable ? "good" : "warn";
    return '<article class="ssh-host-card"><div class="ssh-host-card-heading"><div><p class="ssh-host-workspace">全局主机</p><h3>' + escape(host.hostId) + '</h3></div><span class="badge ' + tone + '">' + credential + '</span></div><p class="ssh-host-address">' + escape(host.username) + '@' + escape(host.host) + ':' + escape(host.port) + '</p><div class="ssh-host-meta"><span>SSH</span><span>端口 ' + escape(host.port) + '</span></div><div class="ssh-host-card-actions"><button type="button" data-ssh-edit="' + escape(host.hostId) + '">编辑</button><button type="button" class="danger" data-ssh-delete="' + escape(host.hostId) + '">删除</button></div></article>';
  }).join("") : '<div class="empty-state"><span aria-hidden="true">⌁</span><h3>尚未保存 SSH 主机</h3><p>添加常用主机后，SSH MCP 工具可以使用别名发起交互式连接。</p></div>';
  $("ssh-host-list").querySelectorAll("[data-ssh-edit]").forEach(button => {
    button.disabled = sshHostBusy || !trusted;
    button.addEventListener("click", () => {
      const host = sshHosts.find(item => item.hostId === button.dataset.sshEdit);
      if (host) openSshHostForm(host);
    });
  });
  $("ssh-host-list").querySelectorAll("[data-ssh-delete]").forEach(button => {
    button.disabled = sshHostBusy || !trusted;
    button.addEventListener("click", async () => {
      const host = sshHosts.find(item => item.hostId === button.dataset.sshDelete);
      if (!host || !(await confirmAction("删除 SSH 主机？", "将删除 " + host.hostId + " 的本地主机记录及对应 Keychain 密码，不会修改远程服务器。"))) return;
      sshHostBusy = true;
      renderSshHosts();
      try {
        await request("/api/ssh/remove", {hostId:host.hostId});
        toast("SSH 主机及本地凭据已删除");
        await loadSshHosts();
      } catch (error) {
        $("ssh-hosts-error").hidden = false;
        $("ssh-hosts-error").textContent = error.message;
      } finally {
        sshHostBusy = false;
        renderSshHosts();
      }
    });
  });
}
async function loadSshHosts() {
  const result = await request("/api/ssh/hosts");
  sshHosts = Array.isArray(result.hosts) ? result.hosts : [];
  sshHostsLoaded = true;
  $("ssh-hosts-error").hidden = true;
  renderSshHosts();
}
async function openSshHosts() {
  sshHostsOpen = true;
  sshHostFormOpen = false;
  sshHostEditing = undefined;
  $("ssh-host-password").value = "";
  $("ssh-hosts-error").hidden = true;
  renderSshHosts();
  const trusted = snapshot?.workspaces?.some(workspace => workspace.mode === "trusted-dev") === true;
  if (!trusted) return;
  $("ssh-hosts-summary").textContent = "正在读取主机列表…";
  try { await loadSshHosts(); }
  catch (error) {
    $("ssh-hosts-error").hidden = false;
    $("ssh-hosts-error").textContent = error.message;
    $("ssh-hosts-summary").textContent = "无法读取 SSH 主机列表";
  }
}
function closeSshHosts() {
  sshHostsOpen = false;
  sshHostFormOpen = false;
  sshHostEditing = undefined;
  $("ssh-host-password").value = "";
  renderSshHosts();
}
function openSshHostForm(host) {
  sshHostEditing = host;
  sshHostFormOpen = true;
  $("ssh-host-form-title").textContent = host ? "编辑 SSH 主机" : "添加 SSH 主机";
  $("ssh-host-id").value = host?.hostId || "";
  $("ssh-host-address").value = host?.host || "";
  $("ssh-host-username").value = host?.username || "";
  $("ssh-host-port").value = String(host?.port || 22);
  $("ssh-host-password").value = "";
  $("ssh-host-password").required = !host || !host.credentialAvailable;
  $("ssh-host-password").placeholder = host?.credentialAvailable ? "留空以保留当前密码" : "请输入要保存的 SSH 密码";
  $("ssh-host-form-hint").textContent = host?.credentialAvailable
    ? "密码已保存在本机 Keychain。留空将保留现有密码；输入新密码则替换。"
    : "尚未检测到已保存密码，必须输入密码。密码不会写入主机元数据或日志。";
  $("ssh-host-form-error").hidden = true;
  renderSshHosts();
  $("ssh-host-id").focus();
}
async function saveSshHost(event) {
  event.preventDefault();
  if (sshHostBusy) return;
  const hostId = $("ssh-host-id").value.trim();
  const host = $("ssh-host-address").value.trim();
  const username = $("ssh-host-username").value.trim();
  const port = Number($("ssh-host-port").value);
  const password = $("ssh-host-password").value;
  if (!hostId || !host || !username || !Number.isInteger(port) || port < 1 || port > 65535) {
    $("ssh-host-form-error").hidden = false;
    $("ssh-host-form-error").textContent = "请完整填写别名、地址、用户名和有效端口。";
    return;
  }
  if ((!sshHostEditing || !sshHostEditing.credentialAvailable) && !password) {
    $("ssh-host-form-error").hidden = false;
    $("ssh-host-form-error").textContent = "请填写 SSH 密码。";
    return;
  }
  const payload = {hostId, host, username, port};
  if (sshHostEditing) payload.previousHostId = sshHostEditing.hostId;
  if (password) payload.password = password;
  sshHostBusy = true;
  $("ssh-host-form-error").hidden = true;
  for (const id of ["ssh-host-id", "ssh-host-address", "ssh-host-username", "ssh-host-port", "ssh-host-password", "ssh-host-form-save"]) $(id).disabled = true;
  try {
    await request("/api/ssh/save", payload);
    $("ssh-host-password").value = "";
    sshHostFormOpen = false;
    sshHostEditing = undefined;
    toast("SSH 主机已保存到本机");
    try { await loadSshHosts(); }
    catch (error) {
      $("ssh-hosts-error").hidden = false;
      $("ssh-hosts-error").textContent = "主机已保存，但列表刷新失败：" + error.message;
    }
  } catch (error) {
    $("ssh-host-form-error").hidden = false;
    $("ssh-host-form-error").textContent = error.message;
  } finally {
    sshHostBusy = false;
    for (const id of ["ssh-host-id", "ssh-host-address", "ssh-host-username", "ssh-host-port", "ssh-host-password", "ssh-host-form-save"]) $(id).disabled = false;
    renderSshHosts();
  }
}
async function refresh() {
  snapshot=await request("/api/snapshot");
  if(!currentWorkspaces().some(w=>w.id===selected)){selected=currentWorkspaces()[0]?.id;selectedModule=undefined;}
  $("settings-codex-summary").textContent = (snapshot.codexDefaults?.defaultModel || "未设置") + " · " + (snapshot.codexDefaults?.defaultEffort || "未设置");
  if (!sshHostsLoaded) $("settings-ssh-summary").textContent = snapshot.workspaces.some(workspace => workspace.mode === "trusted-dev") ? "密码安全保存在本机 Keychain" : "需要至少一个 trusted-dev 工作区";
  renderConnectionSetup();renderApiPortSettings();renderCodexDefaults();renderChain();renderTree();renderInspector();renderGlobalMcps();renderLogs();updateButtons();
}
async function poll() {
  try{await refresh();}catch(error){$("footer-status").textContent=error.message;$("service-error").textContent=error.message;$("service-error").hidden=false;if(expired)updateButtons();}
  if(!expired)setTimeout(poll,1000);
}
$("start").addEventListener("click",()=>command("start"));$("stop").addEventListener("click",()=>command("stop"));$("restart").addEventListener("click",()=>command("restart"));
$("local-mcp-global").addEventListener("click", () => { globalMcpOpen = true; renderGlobalMcps(); });
$("global-mcp-close").addEventListener("click", () => { globalMcpOpen = false; renderGlobalMcps(); });
$("global-mcp-dialog").addEventListener("cancel", () => { globalMcpOpen = false; });
$("global-mcp-dialog").addEventListener("close", () => { globalMcpOpen = false; });
function closeSettingsMenu() {
  $("settings-menu").hidden = true;
  $("settings-toggle").setAttribute("aria-expanded", "false");
}
$("settings-toggle").addEventListener("click", event => {
  event.stopPropagation();
  $("settings-menu").hidden = !$("settings-menu").hidden;
  $("settings-toggle").setAttribute("aria-expanded", String(!$("settings-menu").hidden));
});
$("settings-open-api-ports").addEventListener("click", () => {
  closeSettingsMenu();
  settingsOpen = true;
  renderApiPortSettings();
});
$("settings-edit-codex-defaults").addEventListener("click", () => {
  closeSettingsMenu();
  codexDefaultsOpen = true;
  codexDefaultsInitialized = false;
  renderCodexDefaults();
  $("codex-default-model").focus();
});
$("settings-open-ssh-hosts").addEventListener("click", () => {
  closeSettingsMenu();
  void openSshHosts();
});
$("ssh-hosts-close").addEventListener("click", closeSshHosts);
$("ssh-hosts-dialog").addEventListener("cancel", closeSshHosts);
$("ssh-hosts-dialog").addEventListener("close", () => {
  sshHostsOpen = false;
  sshHostFormOpen = false;
  sshHostEditing = undefined;
  $("ssh-host-password").value = "";
});
$("ssh-host-add").addEventListener("click", () => openSshHostForm(undefined));
$("ssh-host-form-cancel").addEventListener("click", () => {
  sshHostFormOpen = false;
  sshHostEditing = undefined;
  $("ssh-host-password").value = "";
  renderSshHosts();
});
$("ssh-host-form").addEventListener("submit", event => { void saveSshHost(event); });
$("codex-defaults-close").addEventListener("click", () => { codexDefaultsOpen = false; codexDefaultsInitialized = false; renderCodexDefaults(); });
$("codex-defaults-cancel").addEventListener("click", () => { codexDefaultsOpen = false; codexDefaultsInitialized = false; renderCodexDefaults(); });
$("codex-defaults-dialog").addEventListener("cancel", () => { codexDefaultsOpen = false; codexDefaultsInitialized = false; });
$("codex-defaults-dialog").addEventListener("close", () => { codexDefaultsOpen = false; });
document.addEventListener("click", event => {
  if (!event.target.closest(".settings-anchor")) closeSettingsMenu();
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape") closeSettingsMenu();
});
$("connection-wizard").addEventListener("click", () => {
  setupOpen = true;
  setupInitialized = false;
  renderConnectionSetup();
  if (!snapshot?.connectionSetup?.hasTunnelId) $("setup-tunnel-id").focus();
  else if (!snapshot?.connectionSetup?.hasRuntimeKey) $("setup-runtime-key").focus();
});
$("setup-banner-open").addEventListener("click", () => {
  setupOpen = true;
  setupInitialized = false;
  renderConnectionSetup();
});
$("setup-cancel").addEventListener("click", () => { setupOpen = false; $("setup-runtime-key").value = ""; renderConnectionSetup(); });
$("connection-setup-dialog").addEventListener("cancel", () => { setupOpen = false; $("setup-runtime-key").value = ""; });
$("setup-open-settings").addEventListener("click", () => {
  setupOpen = false;
  $("setup-runtime-key").value = "";
  renderConnectionSetup();
  settingsOpen = true;
  settingsInitialized = false;
  renderApiPortSettings();
  $("settings-tunnel-id").focus();
});
$("connection-setup-form").addEventListener("submit", async event => {
  event.preventDefault();
  if(localBusy||snapshot?.busy||snapshot?.status.state!=="stopped"||snapshot?.connectionSetup?.ready)return;
  const state=snapshot.connectionSetup;
  const tunnelId=state.hasTunnelId ? state.tunnelId : $("setup-tunnel-id").value.trim();
  let runtimeKey=state.hasRuntimeKey ? "" : $("setup-runtime-key").value;
  if(!/^tunnel_[A-Za-z0-9_-]{1,128}$/.test(tunnelId)){toast("Tunnel ID 格式无效，应以 tunnel_ 开头。");return;}
  if(!runtimeKey&&!state.hasRuntimeKey){toast("请填写 Runtime API key，或前往设置保存。");return;}
  $("setup-error").hidden=true;
  const ok=await command("connection-setup",{input:{tunnelId,runtimeKey}});
  runtimeKey="";
  $("setup-runtime-key").value="";
  setupInitialized=false;
  settingsInitialized=false;
  await refresh();
  if(!ok) setupOpen=true;
});
$("settings-api-port-close").addEventListener("click", () => { settingsOpen = false; $("settings-runtime-key").value = ""; renderApiPortSettings(); });
$("api-port-dialog").addEventListener("cancel", () => { settingsOpen = false; $("settings-runtime-key").value = ""; });
$("codex-defaults-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (localBusy || snapshot?.busy || snapshot?.status.state !== "stopped") {
    $("codex-defaults-error").hidden = false;
    $("codex-defaults-error").textContent = "请先停止 Bridge，再保存 Codex 默认值。";
    return;
  }
  const defaultModel = $("codex-default-model").value.trim();
  const defaultEffort = $("codex-default-effort").value;
  if (!defaultModel) {
    $("codex-defaults-error").hidden = false;
    $("codex-defaults-error").textContent = "请填写默认模型 ID。";
    return;
  }
  $("codex-defaults-error").hidden = true;
  localBusy = true;
  updateButtons();
  try {
    await request("/api/action", {action:"save-codex-defaults", revision:snapshot.revision, defaultModel, defaultEffort});
    codexDefaultsOpen = false;
    codexDefaultsInitialized = false;
    toast("Codex 默认值已保存");
    await refresh();
  } catch (error) {
    $("codex-defaults-error").hidden = false;
    $("codex-defaults-error").textContent = error.message;
    if (String(error.message).includes("配置已被其他程序修改")) {
      codexDefaultsInitialized = false;
      await refresh().catch(() => {});
    }
  } finally {
    localBusy = false;
    renderCodexDefaults();
    updateButtons();
  }
});
$("api-port-form").addEventListener("submit", async event => {
  event.preventDefault();
  if(localBusy||snapshot?.busy||snapshot?.status.state!=="stopped")return;
  let runtimeKey=$("settings-runtime-key").value;
  const tunnelId=$("settings-tunnel-id").value.trim();
  const bridgePort=Number($("settings-bridge-port").value);
  const healthPort=Number($("settings-health-port").value);
  if(tunnelId&&!/^tunnel_[A-Za-z0-9_-]{1,128}$/.test(tunnelId)){$("api-port-error").hidden=false;$("api-port-error").textContent="Tunnel ID 格式无效，应以 tunnel_ 开头。";return;}
  if(!Number.isInteger(bridgePort)||bridgePort<1||bridgePort>65535){$("api-port-error").hidden=false;$("api-port-error").textContent="Bridge 端口须为 1–65535。";return;}
  if(!Number.isInteger(healthPort)||healthPort<1024||healthPort>65535||healthPort===bridgePort){$("api-port-error").hidden=false;$("api-port-error").textContent="健康检查端口须为 1024–65535，且不能与 Bridge 端口相同。";return;}
  $("api-port-error").hidden=true;
  const input={runtimeKey,bridgePort,healthPort,...(tunnelId?{tunnelId}:{})};
  const ok=await command("save-api-port-settings",{input});
  runtimeKey="";input.runtimeKey="";$("settings-runtime-key").value="";
  if(ok){settingsOpen=false;settingsInitialized=false;setupInitialized=false;await refresh();renderApiPortSettings();}
  else{$("api-port-error").hidden=false;$("api-port-error").textContent=lastCommandError||"保存失败，请检查设置。";}
});
window.addEventListener("native-command",event=>{if(["start","stop","restart"].includes(event.detail))void command(event.detail);});
$("workspace-search").addEventListener("input",()=>snapshot&&renderTree());
$("add").addEventListener("click",()=>{
  if(snapshot.status.state!=="stopped"||localBusy)return;
  if(!draft){draft=snapshot.workspaces.map(w=>({...w}));editRevision=snapshot.revision;}
  let i=1;while(draft.some(w=>w.id===`project-${i}`))i++;
  const w={id:`project-${i}`,root:"",mode:"workspace"};draft.push(w);selectedModule=undefined;selected=w.id;activeTab="details";renderInspector(true);renderTree();$("project-id").focus();
});
$("details-tab").addEventListener("click",()=>{activeTab="details";updateTabs();});$("mcps-tab").addEventListener("click",()=>{activeTab="mcps";updateTabs();});
$("log-search").addEventListener("input",()=>snapshot&&renderLogs());
document.querySelectorAll("[data-source]").forEach(button=>button.addEventListener("click",()=>{sourceFilter=button.dataset.source;document.querySelectorAll("[data-source]").forEach(b=>b.setAttribute("aria-pressed",String(b===button)));if(snapshot)renderLogs();}));
$("clear-logs").addEventListener("click",()=>{clearedThrough=snapshot?.logs.at(-1)?.timestamp || "";if(snapshot)renderLogs();});
$("copy-logs").addEventListener("click",async()=>{
  const text=visibleLogs.map(l=>`[${l.timestamp}] [${l.source}] ${l.message}`).join("\n");
  try{if(navigator.clipboard?.writeText)await navigator.clipboard.writeText(text);else{const area=document.createElement("textarea");area.value=text;document.body.append(area);area.select();document.execCommand("copy");area.remove();}toast("可见日志已复制（鉴权内容已隐藏）");}catch{toast("无法复制，请在日志中选中文字后使用 ⌘C");}
});
poll();
