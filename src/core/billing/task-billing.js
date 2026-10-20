// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 OpenWorkBuddy Contributors
"use strict";
const { AsyncLocalStorage } = require("async_hooks");
const memberModels = require("../model/member-models");
const context = new AsyncLocalStorage();
const current = () => context.getStore() || { billing_scope: "personal", sessionId: "" };
function withTask(value, fn) { return context.run({ billing_scope: value.billing_scope === "team" ? "team" : "personal", sessionId: String(value.sessionId || "") }, fn); }
function sharedModel(config, name) {
  const rows = (config.models || []).filter(m => !memberModels.isOwnName(m.name) && memberModels.sharedToMembers(config, m));
  const row = name ? rows.find(m => m.name === name) : rows.find(m => m.name === config.active_model) || rows[0];
  if (!row) throw Object.assign(new Error("团队任务需要组织共享模型，请先选择共享模型或联系管理员"), { status: 400 }); return row;
}
function summary(rows, org, user) {
  const out = { team: { calls: 0, cost: 0, unknown: 0 }, personal: { calls: 0, cost: 0, unknown: 0 } };
  for (const r of rows) { if (r.org !== org || r.user !== user || !["api", "run"].includes(r.kind)) continue;const part = out[r.billing_scope === "team" ? "team" : "personal"];part.calls++; if (r.cost_unknown || r.local || r.own_key) part.unknown++;else if (Number.isFinite(r.cost) && r.cost > 0) part.cost += r.cost; }
  return out;
}
module.exports = { current, withTask, sharedModel, summary };
