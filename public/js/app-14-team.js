// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 OpenWorkBuddy Contributors
"use strict";
const taskBillingScopes = new Map();
let pendingTaskBillingScope = "personal";
function currentTaskBillingScope(sid = sessionId) { return sid == null ? pendingTaskBillingScope : taskBillingScopes.get(sid) || sessions.find(s => s.id === sid)?.billing_scope || "personal"; }
function resetTaskBillingScope() { pendingTaskBillingScope = "personal"; }
function adoptTaskBillingScope(sid) { taskBillingScopes.set(sid, pendingTaskBillingScope); pendingTaskBillingScope = "personal"; }
function taskModelChoices(rows) { return currentTaskBillingScope() === "team" ? rows.filter(m => m.team_available === true && !m.own && !String(m.name).startsWith("my:")) : rows; }
function taskDefaultModel() { if (currentTaskBillingScope() !== "team") return settingsCache?.active_model; const rows = taskModelChoices(settingsCache?.models || []); return (rows.find(m => m.name === settingsCache?.active_model) || rows[0])?.name; }
function loadTaskBillingScope(sid, scope) { taskBillingScopes.set(sid, scope === "team" ? "team" : "personal"); }
// 对话页只保留任务执行入口。历史任务的费用归属仍从会话数据读取。
function taskBillingBody(sid) { return { billing_scope: currentTaskBillingScope(sid) }; }
