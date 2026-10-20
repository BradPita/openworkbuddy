// @ts-check
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 OpenWorkBuddy Contributors · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 连接器的工具一个个设权限：直接用（allow）/ 先问我（ask）/ 不让用（deny）。
 *
 * 存在 config.mcp_tool_policy：{ 服务器名: { default?: 策略, tools?: { 工具名: 策略 } } }。
 * 只有平台管理员改得了（POST /api/mcp/policy，跟开关同一个判据）。
 *
 * 跟安全档位怎么对：
 *   没设的跟着档位走——「每步都问」「只看不动」先问，「自动改文件」「全自动」直接用。跟命令那套一个意思。
 *   设了的以设的为准，越具体越算数：
 *     不让用：哪一档都不给，工具定义也摘掉，模型看不见；
 *     先问我：哪一档都先问，全自动也问——跟全自动照样要确认的高危命令一个道理，是用户点名要守的；
 *     直接用：每步都问那档也不问（跟命令放行名单一样：点过名的不再问）。
 *   「只看不动」例外：除了不让用的，一律先问——那一档的意思就是没人点头什么都别动。
 *
 * 内置引擎在 agent.js 里按这里判；本机 claude / codex 由 engines/connector-policy.js 翻成它们认的开关，
 * 翻不过去的（问不了人）一律按不让用办：绝不让先问我、不让用的工具不经询问就跑。
 */

const POLICIES = Object.freeze(["allow", "ask", "deny"]);
const BAD_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const MAX_SERVERS = 200;
const MAX_TOOLS = 500;

const own = (/** @type {any} */ o, /** @type {string} */ k) => !!o && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k);
const okName = (/** @type {unknown} */ s) => typeof s === "string" && s.length > 0 && s.length <= 200 && !BAD_KEYS.has(s) && !/[\u0000-\u001f]/.test(s);
const okPolicy = (/** @type {unknown} */ p) => typeof p === "string" && POLICIES.includes(p);

/**
 * 规整成能存的样子：名字不合法、策略不认得的丢掉，空条目不留，条数封顶
 * @param {unknown} raw
 * @returns {Record<string, {default?: string, tools?: Record<string, string>}>}
 */
function clean(raw) {
  /** @type {Record<string, {default?: string, tools?: Record<string, string>}>} */
  const out = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [server, e] of Object.entries(raw).slice(0, MAX_SERVERS)) {
    if (!okName(server) || !e || typeof e !== "object" || Array.isArray(e)) continue;
    /** @type {{default?: string, tools?: Record<string, string>}} */
    const entry = {};
    if (okPolicy(e.default)) entry.default = e.default;
    if (e.tools && typeof e.tools === "object" && !Array.isArray(e.tools)) {
      /** @type {Record<string, string>} */
      const tools = {};
      for (const [t, p] of Object.entries(e.tools).slice(0, MAX_TOOLS)) if (okName(t) && okPolicy(p)) tools[t] = /** @type {string} */ (p);
      if (Object.keys(tools).length) entry.tools = tools;
    }
    if (entry.default || entry.tools) out[server] = entry;
  }
  return out;
}

/**
 * 用户点名设过的那一条（工具上设的优先，其次是整台的默认）；没设过给 ""
 * @param {any} pol @param {string} server @param {string|null} tool
 */
function explicitOf(pol, server, tool) {
  const e = own(pol, server) ? pol[server] : null;
  if (!e || typeof e !== "object") return "";
  if (tool != null && own(e.tools, tool) && okPolicy(e.tools[tool])) return e.tools[tool];
  return okPolicy(e.default) ? e.default : "";
}

/**
 * 这一档下这个工具实际怎么办。mode 是 security.permissionMode 的四档之一
 * @param {any} pol @param {string} server @param {string|null} tool @param {string} mode
 * @returns {"allow"|"ask"|"deny"}
 */
function effective(pol, server, tool, mode) {
  const p = explicitOf(pol, server, tool);
  if (p === "deny") return "deny";
  if (mode === "plan") return "ask";
  if (p === "ask" || p === "allow") return p;
  return mode === "ask" ? "ask" : "allow";
}

/** 工具表里要不要摆这一个：只有点名「不让用」的不摆（跟档位无关） */
const offered = (/** @type {any} */ pol, /** @type {string} */ server, /** @type {string} */ tool) => explicitOf(pol, server, tool) !== "deny";

/** 一台连接器的策略原样给页面（没设过就是空的） */
function viewOf(/** @type {any} */ pol, /** @type {string} */ server) {
  const e = own(pol, server) ? pol[server] : null;
  return { default: e && okPolicy(e.default) ? e.default : "", tools: e && e.tools && typeof e.tools === "object" ? { ...e.tools } : {} };
}

/**
 * 改一台的策略：patch.default / patch.tools[工具] 给 "" 就是删掉那一条，回到跟着档位走
 * @param {any} pol @param {string} server @param {{default?: unknown, tools?: unknown}} patch
 */
function withServer(pol, server, patch) {
  if (!okName(server)) throw new Error("连接器名字不对");
  const all = clean(pol);
  const cur = viewOf(all, server);
  /** @type {{default?: string, tools: Record<string, string>}} */
  const next = { default: cur.default, tools: { ...cur.tools } };
  if (patch && own(patch, "default")) {
    if (patch.default === "" || patch.default == null) delete next.default;
    else if (okPolicy(patch.default)) next.default = /** @type {string} */ (patch.default);
    else throw new Error("权限只能是直接用、先问我、不让用");
  }
  if (patch && patch.tools && typeof patch.tools === "object" && !Array.isArray(patch.tools)) {
    for (const [t, p] of Object.entries(patch.tools)) {
      if (!okName(t)) continue;
      if (p === "" || p == null) delete next.tools[t];
      else if (okPolicy(p)) next.tools[t] = /** @type {string} */ (p);
      else throw new Error("权限只能是直接用、先问我、不让用");
    }
  }
  delete all[server];
  const entry = clean({ [server]: next })[server];
  if (entry) all[server] = entry;
  return all;
}

/** 连接器删掉了，它的策略别长住 */
function prune(/** @type {any} */ pol, /** @type {string[]} */ alive) {
  const keep = new Set(alive);
  return Object.fromEntries(Object.entries(clean(pol)).filter(([k]) => keep.has(k)));
}

const SECRET_KEY = /key|token|secret|pass|pwd|auth|cred|cookie|session|sig/i;
const LOOKS_SECRET = /^(?:bearer\s+)?[A-Za-z0-9_\-.+/=]{24,}$/i;
/**
 * 审批卡上的参数：像 Key、令牌、密码的值打码，长的截断。卡片上看的是「它要干什么」，不是把密钥再展示一遍
 * @param {unknown} input
 */
function previewArgs(input, max = 600) {
  const mask = (/** @type {unknown} */ v, /** @type {string} */ k, /** @type {number} */ depth) => {
    if (depth > 4) return "…";
    if (typeof v === "string") {
      if ((k && SECRET_KEY.test(k)) || (LOOKS_SECRET.test(v.trim()) && /\d/.test(v) && /[A-Za-z]/.test(v))) return v ? "••••" : "";
      return v.length > 200 ? v.slice(0, 200) + "…" : v;
    }
    if (Array.isArray(v)) return v.slice(0, 20).map((x) => mask(x, k, depth + 1));
    if (v && typeof v === "object") {
      /** @type {Record<string, unknown>} */
      const o = {};
      for (const [kk, vv] of Object.entries(v).slice(0, 40)) o[kk] = SECRET_KEY.test(kk) && vv != null && typeof vv !== "object" ? "••••" : mask(vv, kk, depth + 1);
      return o;
    }
    return v;
  };
  let s = "";
  try { s = JSON.stringify(mask(input, "", 0)) || ""; } catch { s = ""; }
  return s.length > max ? s.slice(0, max) + "…" : s;
}

/**
 * 内置引擎调用连接器工具前过一道：放行回 null，拦下回给模型看的结果。
 * 先问我的摆一张跟改文件、跑命令一样的审批卡；等多久、叫停收卡也一样
 * @param {{pol: any, sec: any, server: string, tool: string, input: unknown, stopSignal?: AbortSignal, deadline?: number, source?: string, owner?: string, sessionId?: string}} o
 * @returns {Promise<null | {content: string, isError: true}>}
 */
async function gate({ pol, sec, server, tool, input, stopSignal, deadline, source = "", owner = "", sessionId = "" }) {
  const security = require("../safety/security");
  const verdict = effective(pol, server, tool, security.permissionMode(sec));
  if (verdict === "allow") return null;
  const text = `连接器 ${server} 的工具 ${tool}\n参数：${previewArgs(input)}`;
  if (verdict === "deny") {
    security.audit("连接器工具拦截", text, "拦截");
    return { content: `连接器 ${server} 的 ${tool} 设成了不让用，没有执行。换一种做法，或者请平台管理员在连接器页上改它的权限。`, isError: true };
  }
  security.audit("连接器工具审批", text, "等待审批");
  const waitMs = Math.min(((sec && sec.approval_timeout_s) || 120) * 1000, deadline ? Math.max(5000, deadline - Date.now() - 10000) : Infinity);
  const ok = await security.requestApproval("连接器工具执行", text, {
    timeoutMs: waitMs,
    stopSignal,
    rule: explicitOf(pol, server, tool) === "ask" ? "连接器工具设了先问我" : `当前档位是「${security.PERMISSION_MODES[security.permissionMode(sec)].label}」`,
    ruleKey: "", // 这一类在设置里没有「以后都放行」：要放行去连接器页上把它改成直接用
    source,
    owner,
    sessionId,
  });
  security.audit("连接器工具审批", text, ok ? "已批准" : "已拒绝");
  if (ok) return null;
  // 别说「用户拒了」：也可能是等超时、或者当时没人在跟前
  return { content: `连接器 ${server} 的 ${tool} 没批下来：被拒、等超时，或者当时没人能批，没有执行。换一种不需要它的做法，或者说清楚要干什么、让用户决定。`, isError: true };
}

module.exports = { POLICIES, clean, explicitOf, effective, offered, viewOf, withServer, prune, previewArgs, gate };
