"use strict";
const $ = id => document.getElementById(id);
const escape = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
const modes = { readonly:"只读", workspace:"普通工作区", "trusted-dev":"可信开发", handoff:"交接模式" };
const lifecycleLabels = { stopped:"已停止", starting:"正在启动", running:"运行中", stopping:"正在停止", error:"服务异常" };
const tokenKey = "bridge-ui-session";
let credential = location.hash.slice(1) || sessionStorage.getItem(tokenKey) || "";
if (location.hash) { sessionStorage.setItem(tokenKey, credential); history.replaceState(null, "", "/"); }
let snapshot, selected, selectedModule, draft, editRevision, lastSelection, activeTab = "details", localBusy = false;
let chainSignature = "", treeSignature = "", detailsSignature = "", mcpsSignature = "";
let sourceFilter = "all", clearedThrough = "", visibleLogs = [], logSignature = "", toastTimer, expired = false;

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
    ["chatgpt", "ChatGPT", connected ? "Tunnel 可连接" : "等待隧道", connected ? "good" : ""],
    ["secure-tunnel", "Secure Tunnel", connected ? "已连接" : s.tunnel === "error" ? "连接异常" : "未连接", connected ? "good" : s.tunnel === "error" ? "bad" : ""],
    ["mcp", "MCP", s.mcp === "available" ? "工具服务可用" : "未运行", s.mcp === "available" ? "good" : ""],
    ["mcp-bridge", "MCP Bridge", s.bridge === "running" ? "运行中" : s.state === "error" ? "服务异常" : "已停止", s.bridge === "running" ? "good" : s.state === "error" ? "bad" : ""],
    ["codex-desktop", "Codex Desktop", c.ipcConnected ? "IPC 已连接" : c.enabled ? "等待 Desktop" : "未配置", c.ipcConnected ? "good" : ""],
  ];
  $("chain").innerHTML = nodes.map(([icon, title, state, tone], i) => `${i ? '<span class="chain-arrow" aria-hidden="true">›</span>' : ""}<div class="chain-node"><img src="/icons/${icon}.png" alt=""><div><h3>${title}</h3><p><i class="dot ${tone}"></i>${state}</p></div></div>`).join("");
  $("lifecycle").textContent = lifecycleLabels[s.state] || s.state;
  $("lifecycle").className = "badge" + (s.state === "running" ? " good" : ["starting","stopping"].includes(s.state) ? " warn" : "");
  $("runtime-meta").textContent = [s.pid ? `PID ${s.pid}` : "", s.port ? `端口 ${s.port}` : "", s.startedAt ? new Date(s.startedAt).toLocaleTimeString("zh-CN",{hour12:false})+" 启动" : ""].filter(Boolean).join(" · ");
  $("service-error").hidden = !s.error; $("service-error").textContent = s.error || "";
}
function renderTree() {
  const filter = $("workspace-search").value.toLowerCase();
  const rows = currentWorkspaces().map(w => {
    const modules = (snapshot.codexBindings || []).filter(m => m.workspaceId === w.id);
    const matches = w.id.toLowerCase().includes(filter) || modules.some(m => m.displayName.toLowerCase().includes(filter));
    if (!matches) return "";
    return `<div class="tree-group"><button class="tree-row ${selected === w.id && !selectedModule ? "selected" : ""}" data-workspace="${escape(w.id)}" aria-label="项目 ${escape(w.id)}" aria-current="${selected === w.id && !selectedModule ? "true" : "false"}"><span class="tree-glyph" aria-hidden="true">▱</span><span class="label">${escape(w.id)}</span><span class="small">${escape(modes[w.mode])}</span></button>${modules.map(m => `<button class="tree-row module-row ${selected === w.id && selectedModule === m.moduleId ? "selected" : ""}" data-workspace="${escape(w.id)}" data-module="${escape(m.moduleId)}"><span class="tree-glyph" aria-hidden="true">${m.moduleKind === "configured" ? "◇" : "◌"}</span><span class="label">${escape(m.displayName)}</span><i class="dot ${m.bindingStatus === "bound" ? "good" : ""}"></i></button>`).join("")}</div>`;
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
function updateTabs() { $("details").hidden=activeTab!=="details";$("mcps").hidden=activeTab!=="mcps";$("details-tab").setAttribute("aria-selected",String(activeTab==="details"));$("mcps-tab").setAttribute("aria-selected",String(activeTab==="mcps")); }
function updateButtons() {
  const s=snapshot?.status.state || "stopped",busy=localBusy||snapshot?.busy;
  $("start").disabled=expired||busy||!!draft||!["stopped","error"].includes(s);
  $("start").textContent=s==="starting"?"正在启动…":"▶ 启动服务";
  $("stop").disabled=expired||busy||!["running","error"].includes(s);
  $("restart").disabled=expired||busy||!!draft||s!=="running";
  $("add").disabled=expired||busy||s!=="stopped";
  document.querySelectorAll("[data-requires-stopped]").forEach(button=>button.disabled=busy||s!=="stopped");
  for(const name of ["save-config","cancel-edit","pick-folder","project-id","project-root","project-mode"])if($(name))$(name).disabled=busy||s!=="stopped";
  if($("remove-workspace"))$("remove-workspace").disabled=busy||s!=="stopped"||draft?.length<2;
  $("footer-status").textContent=expired?"会话已过期，请重新打开应用":draft&&snapshot?.revision!==editRevision?"配置已在外部变化；取消编辑后重新载入":draft?"项目配置有未保存的修改":busy?"正在执行操作…":s==="running"?"服务运行中 · 状态实时更新":"本机控制台已就绪";
}
function renderLogs() {
  const filter=$("log-search").value.toLowerCase();
  visibleLogs=snapshot.logs.filter(log=>log.timestamp>clearedThrough&&(sourceFilter==="all"||log.source===sourceFilter)&&log.message.toLowerCase().includes(filter));
  const signature=JSON.stringify(visibleLogs);if(signature===logSignature)return;logSignature=signature;
  $("log-count").textContent=`${visibleLogs.length} 条`;$("log-empty").hidden=visibleLogs.length>0;
  $("log-lines").replaceChildren(...visibleLogs.map(log=>{
    const row=document.createElement("div");row.className=`log-row ${log.stream}`;
    const time=document.createElement("span");time.className="log-time";time.textContent=new Date(log.timestamp).toLocaleTimeString("zh-CN",{hour12:false});
    const source=document.createElement("span");source.className="log-source";source.textContent=log.source;
    const message=document.createElement("span");message.className="log-message";message.textContent=log.message;
    row.append(time,source,message);return row;
  }));
  if($("follow").checked)$("log-scroll").scrollTop=$("log-scroll").scrollHeight;
}
async function refresh() {
  snapshot=await request("/api/snapshot");
  if(!currentWorkspaces().some(w=>w.id===selected)){selected=currentWorkspaces()[0]?.id;selectedModule=undefined;}
  renderChain();renderTree();renderInspector();renderLogs();updateButtons();
}
async function poll() {
  try{await refresh();}catch(error){$("footer-status").textContent=error.message;$("service-error").textContent=error.message;$("service-error").hidden=false;if(expired)updateButtons();}
  if(!expired)setTimeout(poll,1000);
}
$("start").addEventListener("click",()=>command("start"));$("stop").addEventListener("click",()=>command("stop"));$("restart").addEventListener("click",()=>command("restart"));
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
