// @ts-check
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 OpenWorkBuddy Contributors · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 连接器页上给每个工具设的权限（core/ext/mcp-policy.js），翻成本机 claude / codex 认的开关。
 *
 * claude：
 *   整台直接用的挂 --allowed-tools mcp__<名>；点名不让用的进 --disallowed-tools mcp__<名>__<工具>；
 *   先问我的写成「先问」规则，claude 碰到就来问 --permission-prompt-tool（approve.js 按 rules 判、摆卡等人点）。
 *   整台默认先问的，再补一条整台的「先问」：用户自己 claude 设置里放行过同名的也压得住（先问比放行优先），
 *   点名直接用的那几个到了审批那头按 rules 直接放。
 *   全自动档（bypassPermissions）下 claude 不理「先问」规则，只认「不让用」：先问我的只能按不让用办，
 *   整台默认不是直接用的那几台，没法只放其中几个，整台不挂。
 * codex：exec 从不停下来问人，先问我一律按不让用办；按工具开关走 enabled_tools / disabled_tools。
 *
 * 问不了人（这一趟没有审批回传，或者引擎本身不问）就按不让用办。原则：绝不让先问我、不让用的工具不经询问就跑。
 */
const { clean, effective } = require("../core/ext/mcp-policy");

/** claude 的规则按 mcp__服务器__工具 原样比对；工具名里有别的字符时它会改写，规则就对不上了 */
const SAFE_TOOL = /^[A-Za-z0-9_-]{1,64}$/;

const own = (/** @type {any} */ o, /** @type {string} */ k) => !!o && Object.prototype.hasOwnProperty.call(o, k);

/**
 * 这一趟 claude 是不是跳过一切询问（全自动档，或者属主在引擎参数里自己开了）
 * @param {string} engineId @param {string} [claudeMode] @param {unknown[]} [extraArgs]
 */
function bypassOf(engineId, claudeMode = "", extraArgs = []) {
  if (engineId !== "claude-code") return false;
  if (claudeMode === "bypassPermissions") return true;
  const a = (Array.isArray(extraArgs) ? extraArgs : []).map(String);
  return a.some((x, i) => x === "--dangerously-skip-permissions" || x === "--permission-mode=bypassPermissions" || (x === "--permission-mode" && a[i + 1] === "bypassPermissions"));
}

/**
 * @typedef {{cli: string, name: string, why: string, quiet: boolean}} Dropped
 * @typedef {{server: string, default: string, tools: Record<string, string>}} Rule
 */

/**
 * @param {{cli: string, name: string}[]} servers 要交给 CLI 的用户连接器：cli 是在 CLI 里的名字，name 是连接器页上的名字
 * @param {{policy?: any, mode?: string, engine?: string, askHuman?: boolean, bypass?: boolean, known?: (name: string) => string[]}} o
 *   mode：安全档位（security.permissionMode）；askHuman：这一趟能不能摆卡问人；
 *   known：内置那边已经连上、看得见的工具名（有就拿它把默认不让用的点名摘掉，多一道保险）
 */
function plan(servers, { policy = {}, mode = "auto", engine = "claude-code", askHuman = false, bypass = false, known = () => [] } = {}) {
  const pol = clean(policy);
  const out = {
    allowServers: /** @type {string[]} */ ([]),
    allow: /** @type {string[]} */ ([]),
    ask: /** @type {string[]} */ ([]),
    deny: /** @type {string[]} */ ([]),
    drop: /** @type {Dropped[]} */ ([]),
    enabledTools: /** @type {Record<string, string[]>} */ ({}),
    disabledTools: /** @type {Record<string, string[]>} */ ({}),
    rules: /** @type {Record<string, Rule>} */ ({}),
    unavailable: /** @type {string[]} */ ([]),
  };
  const claude = engine === "claude-code";
  const canAsk = claude && askHuman && !bypass;
  for (const { cli, name } of servers || []) {
    const d = effective(pol, name, null, mode);
    const named = own(pol, name) && pol[name].tools ? Object.keys(pol[name].tools) : [];
    /** @type {[string, "allow"|"ask"|"deny"][]} */
    const per = named.map((t) => [t, effective(pol, name, t, mode)]);
    const drop = (/** @type {string} */ why, quiet = false) => out.drop.push({ cli, name, why, quiet });
    const noAsk = (/** @type {string} */ t) => out.unavailable.push(`${name} 的 ${t}`);
    if (!claude) {
      if (d === "allow") {
        const off = per.filter(([, p]) => p !== "allow").map(([t]) => t);
        for (const [t, p] of per) if (p === "ask") noAsk(t);
        if (off.length) out.disabledTools[cli] = off;
      } else {
        const on = per.filter(([, p]) => p === "allow").map(([t]) => t);
        if (!on.length) { drop(d === "deny" ? "整台设了不让用" : "这个引擎没法先问你", d === "deny"); continue; }
        out.enabledTools[cli] = on;
      }
      continue;
    }
    const rule = (/** @type {string} */ t) => `mcp__${cli}__${t}`;
    if (d === "allow") {
      // 要摘、要问的工具名写不成规则：整台放行就等于放了它，宁可整台不挂
      if (per.some(([t, p]) => p !== "allow" && !SAFE_TOOL.test(t))) { drop("有工具名没法单独设权限"); continue; }
      out.allowServers.push(cli);
      for (const [t, p] of per) {
        if (p === "deny") out.deny.push(rule(t));
        else if (p === "ask" && canAsk) out.ask.push(rule(t));
        else if (p === "ask") { out.deny.push(rule(t)); noAsk(t); }
      }
    } else {
      if (bypass) { drop(d === "deny" ? "整台设了不让用" : "全自动档下没法先问你", d === "deny" && !per.some(([, p]) => p === "allow")); continue; }
      const usable = per.some(([t, p]) => SAFE_TOOL.test(t) && (p === "allow" || (p === "ask" && canAsk)));
      if (!(d === "ask" && canAsk) && !usable) { drop(d === "deny" ? "整台设了不让用" : "这一趟没法先问你", d === "deny"); continue; }
      if (d === "ask" && canAsk) out.ask.push(`mcp__${cli}`);
      for (const [t, p] of per) {
        if (!SAFE_TOOL.test(t)) continue; // 写不成规则的落回整台的默认（问或不让用），只会更严
        if (p === "allow") out.allow.push(rule(t));
        else if (p === "deny") out.deny.push(rule(t));
        else if (canAsk) out.ask.push(rule(t));
        else { out.deny.push(rule(t)); noAsk(t); }
      }
      // 问不了人时，没点名的那些靠 -p 下「没放行就不给」兜着；内置那边看得见的再点名摘一遍
      if (!canAsk) for (const t of known(name) || []) if (SAFE_TOOL.test(t) && !per.some(([x]) => x === t)) out.deny.push(rule(t));
    }
    out.rules[cli] = { server: name, default: d, tools: Object.fromEntries(per) };
  }
  return out;
}

/**
 * claude 来问「这个工具能不能用」时，按连接器页上的权限认：认不出是哪台的回 null（交给别的规则判）
 * @param {Record<string, Rule> | null | undefined} rules @param {string} toolName
 * @returns {null | {server: string, tool: string, policy: string}}
 */
function ruleFor(rules, toolName) {
  const name = String(toolName || "");
  if (!rules || !name.startsWith("mcp__")) return null;
  const rest = name.slice(5);
  let cli = "";
  for (const k of Object.keys(rules)) if (k.length > cli.length && rest.startsWith(k + "__")) cli = k;
  if (!cli) return null;
  const r = rules[cli];
  const tool = rest.slice(cli.length + 2);
  if (!tool) return null;
  return { server: r.server, tool, policy: own(r.tools, tool) ? r.tools[tool] : r.default };
}

module.exports = { SAFE_TOOL, bypassOf, plan, ruleFor };
