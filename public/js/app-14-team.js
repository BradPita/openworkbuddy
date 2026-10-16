// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 OpenWorkBuddy Contributors
"use strict";
const taskBillingScopes = new Map(), taskBillingLocked = new Set();
let pendingTaskBillingScope = "personal";
function currentTaskBillingScope(sid = sessionId) { return sid == null ? pendingTaskBillingScope : taskBillingScopes.get(sid) || sessions.find(s => s.id === sid)?.billing_scope || "personal"; }
function resetTaskBillingScope() { pendingTaskBillingScope = "personal"; syncTaskBillingControls(); }
function adoptTaskBillingScope(sid) { taskBillingScopes.set(sid, pendingTaskBillingScope); pendingTaskBillingScope = "personal"; }
function taskModelChoices(rows) { return currentTaskBillingScope() === "team" ? rows.filter(m => m.team_available === true && !m.own && !String(m.name).startsWith("my:")) : rows; }
function taskDefaultModel() { if (currentTaskBillingScope() !== "team") return settingsCache?.active_model; const rows = taskModelChoices(settingsCache?.models || []); return (rows.find(m => m.name === settingsCache?.active_model) || rows[0])?.name; }
function lockTaskBillingScope(sid) { taskBillingLocked.add(sid); syncTaskBillingControls(); }
function loadTaskBillingScope(sid, scope, locked) { taskBillingScopes.set(sid, scope === "team" ? "team" : "personal"); if (locked) taskBillingLocked.add(sid); syncTaskBillingControls(); }
function syncTaskBillingControls() {
  const label = document.getElementById("task-billing-control"), select = document.getElementById("task-billing-scope"), cost = document.getElementById("task-billing-cost"); if (!label || !select || !cost) return;
  cost.hidden = settingsCache?.solo !== false; label.hidden = cost.hidden || (typeof inAssistMode !== "undefined" && inAssistMode);
  select.value = currentTaskBillingScope();
  select.disabled = taskBillingLocked.has(sessionId) || runningSessions.has(sessionId);
  label.title = I18N.t(select.value === "team" ? "使用组织共享模型和连接器，费用标记为团队任务。" : "按个人选择运行；费用单独记为个人任务。");
}
function taskBillingBody(sid) { return { billing_scope: currentTaskBillingScope(sid) }; }
document.getElementById("task-billing-scope").onchange = async e => {
  const scope = e.target.value === "team" ? "team" : "personal";
  if (sessionId == null) pendingTaskBillingScope = scope; else taskBillingScopes.set(sessionId, scope);
  syncTaskBillingControls();
  if (scope === "team") {
    const model = taskDefaultModel();
    if (model) {
      if (sessionId == null) pendingModel = model;
      else if (typeof setSessionModel === "function") await setSessionModel(model);
    }
    toast(model ? "团队任务使用组织共享模型和连接器，请选择共享模型。" : "团队任务需要组织共享模型，请先选择共享模型或联系管理员");
  }
  if (typeof updateModelLabel === "function") updateModelLabel();
  if (typeof renderModelMenu === "function") renderModelMenu();
};
document.getElementById("task-billing-cost").onclick = async () => {
  const existing = document.getElementById("task-cost-panel"); if(existing){existing.remove();return;}
  const panel=document.createElement("section");panel.id="task-cost-panel";panel.className="session-share-panel";panel.textContent=I18N.t("正在读取费用…");document.getElementById("chat-scroll").prepend(panel);
  try {const r=await fetch("/api/my-task-costs");const data=await r.json();if(!r.ok)throw Error(data.error||I18N.t("读取费用失败"));panel.replaceChildren();const title=document.createElement("h3");title.textContent=data.month+" · "+I18N.t("我的任务费用");panel.appendChild(title);
    for(const key of ["team","personal"]){const p=document.createElement("p"),v=data[key];p.textContent=I18N.t(key==="team"?"团队任务":"个人任务")+`: ¥${Number(v.cost).toFixed(4)} · `+I18N.t("未定价记录")+`: ${v.unknown}`;panel.appendChild(p);}
    const hint=document.createElement("p");hint.textContent=I18N.t("这是按配置价目估算的用量记录；未知价格单列，实际金额以上游账单为准。组织预算规则仍然适用。");panel.appendChild(hint);
    const close=document.createElement("button");close.className="btn-plain";close.textContent=I18N.t("收起");close.onclick=()=>panel.remove();panel.appendChild(close);
  }catch(e){panel.textContent=e.message;}
};
syncTaskBillingControls();
