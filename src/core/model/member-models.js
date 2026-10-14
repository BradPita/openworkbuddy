// @ts-check
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 多人服务器上「成员能用哪些对话模型」。
 *
 * 两件事：
 *   1. 平台管理员配的渠道，可以逐个说「这家不给成员用」（渠道上 share_members: false）。
 *      比如自己那把 Opus 的 Key 只留给自己，便宜那家共享出去。没写这个字段 = 共享，老配置照旧。
 *   2. 成员可以填自己的 Key（存在他自己的偏好文件 data/prefs/<账号>.json 的 my_models 里），
 *      只有他看得见、用得着；花的是他自己的钱，不扣组织积分、不进组织预算。
 *      平台管理员可以整台关掉这条路（config.member_byok === false）。
 *
 * 自带的那几条在运行期叫「my:<名字>」：前缀让它永远不会跟管理员配的同名条目撞上，
 * 记账那头（account.chargeOne）也靠这个前缀认出「这一趟是他自己掏钱」。
 *
 * 平台管理员和个人桌面版不走这里的过滤：他们看到的就是 config.models 全表。
 */

const PREFIX = "my:";
const MAX_OWN = 20;
const PROTOS = ["openai", "anthropic", "openai-responses", "gemini", "ollama"];

const isOwnName = (name) => typeof name === "string" && name.startsWith(PREFIX);

/** 成员能不能自己填 Key。没写 = 能 */
function byokAllowed(config) {
  return !(config && config.member_byok === false);
}

/** 这条管理员配的模型给不给成员用：看它挂的渠道 */
function sharedToMembers(config, m) {
  if (!m) return false;
  const ch = String(m.channel || "");
  if (!ch) return true;
  const p = ((config && config.providers) || []).find((x) => x && x.id === ch);
  return !(p && p.share_members === false);
}

/** 规整一条自带模型。返回 null = 这行不要 */
function cleanOwn(r) {
  if (!r || typeof r !== "object") return null;
  const label = String(r.label || r.name || "").replace(/^my:/, "").trim().slice(0, 40);
  const model = String(r.model || "").trim().slice(0, 200);
  if (!label || !model) return null;
  const provider = PROTOS.includes(String(r.provider || "")) ? String(r.provider) : "openai";
  return {
    label,
    provider,
    base_url: String(r.base_url || "").trim().slice(0, 500),
    api_key: String(r.api_key || "").trim(),
    model,
  };
}

/** 偏好文件里那份自带模型（规整过的） */
function ownList(prefsData) {
  const raw = prefsData && Array.isArray(prefsData.my_models) ? prefsData.my_models : [];
  const out = [];
  for (const r of raw) {
    const c = cleanOwn(r);
    if (c && !out.some((x) => x.label === c.label)) out.push(c);
  }
  return out.slice(0, MAX_OWN);
}

/** 运行期那一行：跟 config.models 的条目同一个形状，llm.js 拿去就能跑 */
function rowOf(own) {
  return { name: PREFIX + own.label, provider: own.provider, base_url: own.base_url, api_key: own.api_key, model: own.model, own: true };
}

/**
 * 这个人能用的全部对话模型。
 * @param {any} config
 * @param {{ owner: boolean, prefs?: any }} who  owner = 平台管理员或个人桌面版
 */
function listFor(config, who) {
  const all = (config && config.models) || [];
  if (who.owner) return all;
  const shared = all.filter((m) => sharedToMembers(config, m));
  const own = byokAllowed(config) ? ownList(who.prefs).map(rowOf) : [];
  return shared.concat(own);
}

/** 按名字找这个人能用的那一行；用不了回 null */
function find(config, who, name) {
  if (!name) return null;
  return listFor(config, who).find((m) => m.name === name) || null;
}

/**
 * 这个人不点名时用哪一个：全局默认他用得着就是它，用不着就是他能用的第一个。
 * 一个都没有回 null。
 */
function defaultFor(config, who) {
  const list = listFor(config, who);
  return list.find((m) => m.name === (config && config.active_model)) || list[0] || null;
}

/** 读接口给前端的形状：Key 一律只回 has_key */
function publicOwn(prefsData) {
  return ownList(prefsData).map((o) => ({
    name: PREFIX + o.label, label: o.label, provider: o.provider, base_url: o.base_url, model: o.model,
    has_key: !!o.api_key, api_key: o.api_key ? "********" : "",
  }));
}

/**
 * 存回来的那份：表单整表提交，Key 原样是八颗星的按「没改」处理（按 label 认旧行）。
 * 不合格的行直接报错，别悄悄丢掉一条用户刚填的。
 */
function mergeIncoming(prefsData, incoming) {
  if (!Array.isArray(incoming)) throw new Error("my_models 要是一个列表");
  if (incoming.length > MAX_OWN) throw new Error(`自己的模型最多 ${MAX_OWN} 个`);
  const old = new Map(ownList(prefsData).map((o) => [o.label, o]));
  const out = [];
  for (const r of incoming) {
    const prevLabel = String((r && (r.prev_label || r.label)) || "").replace(/^my:/, "").trim();
    const c = cleanOwn(r);
    if (!c) throw new Error("每个模型都要填名字和模型名");
    if (out.some((x) => x.label === c.label)) throw new Error(`名字「${c.label}」重复了`);
    if (/^\*+$/.test(c.api_key)) c.api_key = (old.get(prevLabel) || old.get(c.label) || {}).api_key || "";
    if (c.provider !== "ollama" && !c.api_key && !/localhost|127\.0\.0\.1|\[::1\]/.test(c.base_url)) {
      throw new Error(`「${c.label}」还没填 API Key`);
    }
    out.push(c);
  }
  return out;
}

module.exports = {
  PREFIX, MAX_OWN, isOwnName, byokAllowed, sharedToMembers, ownList, rowOf, listFor, find, defaultFor, publicOwn, mergeIncoming,
};
