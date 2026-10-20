// @ts-check
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 OpenWorkBuddy Contributors · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 从本机别的应用里已经配好的连接器挑几台导进来，省得把命令和 Key 再抄一遍。
 *
 * 认这几处（格式照各家公开文档）：
 *   Claude Desktop  claude_desktop_config.json 的 mcpServers（mac 在 ~/Library/Application Support/Claude，
 *                   Windows 在 %APPDATA%\Claude，Linux 在 ~/.config/Claude）
 *   Claude Code     ~/.claude.json 顶层的 mcpServers——这个文件里还有别的东西，只取这一个键，别的不留、不记、不回传
 *   Cursor          ~/.cursor/mcp.json 的 mcpServers
 *   Codex           ~/.codex/config.toml 的 [mcp_servers.*]（下面写了个够用的 TOML 子集）
 * 路径都能用环境变量改：OWB_IMPORT_HOME 换掉整个家目录（测试一律这么用），
 * OWB_IMPORT_CLAUDE_DESKTOP / OWB_IMPORT_CLAUDE_JSON / OWB_IMPORT_CURSOR / OWB_IMPORT_CODEX 单独指一个文件。
 *
 * 页面只拿得到 list() 那份清单：来源、名字、传输方式、命令或地址、键名，没有一个值
 * （命令行参数、地址里像密钥的部分也打了码）。真导入时服务端用 pick() 自己从文件里再取一遍值，值不经过页面。
 * 只读这几个配置文件，任何登录凭据文件都不碰。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const MAX_BYTES = 20 * 1024 * 1024;
const BAD_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const SECRET_NAME = /key|token|secret|pass|pwd|auth|cred|cookie|session|sig/i;
const MASK = "••••";

/** @typedef {{id: string, label: string, file: string, format: "json"|"toml", key: string}} Source */

/**
 * @param {NodeJS.ProcessEnv} [env] @param {string} [platform]
 * @returns {Source[]}
 */
function sources(env = process.env, platform = process.platform) {
  const fake = env.OWB_IMPORT_HOME || "";
  const home = fake || os.homedir();
  // 换了家目录就一路换到底：APPDATA、XDG_CONFIG_HOME、CODEX_HOME 都不再看真的那份
  const appData = fake ? path.join(home, "AppData", "Roaming") : env.APPDATA || path.join(home, "AppData", "Roaming");
  const xdg = fake ? path.join(home, ".config") : env.XDG_CONFIG_HOME || path.join(home, ".config");
  const desktop = platform === "darwin" ? path.join(home, "Library", "Application Support", "Claude")
    : platform === "win32" ? path.join(appData, "Claude") : path.join(xdg, "Claude");
  const codexHome = fake ? path.join(home, ".codex") : env.CODEX_HOME || path.join(home, ".codex");
  return [
    { id: "claude-desktop", label: "Claude Desktop", file: env.OWB_IMPORT_CLAUDE_DESKTOP || path.join(desktop, "claude_desktop_config.json"), format: "json", key: "mcpServers" },
    { id: "claude-code", label: "Claude Code", file: env.OWB_IMPORT_CLAUDE_JSON || path.join(home, ".claude.json"), format: "json", key: "mcpServers" },
    { id: "cursor", label: "Cursor", file: env.OWB_IMPORT_CURSOR || path.join(home, ".cursor", "mcp.json"), format: "json", key: "mcpServers" },
    { id: "codex", label: "Codex", file: env.OWB_IMPORT_CODEX || path.join(codexHome, "config.toml"), format: "toml", key: "mcp_servers" },
  ];
}

// ---------------- 够用的 TOML 子集：表头、点号键、字符串、数字、布尔、数组、行内表 ----------------

/** @param {string} text @returns {Record<string, any>} */
function parseToml(text) {
  /** @type {Record<string, any>} */
  const root = {};
  let cur = root;
  let i = 0;
  const n = text.length;
  const fail = (/** @type {string} */ why) => { throw new Error(`第 ${text.slice(0, i).split("\n").length} 行${why}`); };
  const ws = () => { while (i < n && (text[i] === " " || text[i] === "\t")) i++; };
  const comment = () => { if (text[i] === "#") while (i < n && text[i] !== "\n") i++; };
  const blank = () => { for (;;) { ws(); comment(); if (text[i] === "\n" || text[i] === "\r") { i++; continue; } return; } };
  const hex = (/** @type {number} */ len) => {
    const h = text.slice(i, i + len);
    if (!/^[0-9a-fA-F]+$/.test(h) || h.length !== len) fail("的转义写错了");
    i += len;
    return String.fromCodePoint(parseInt(h, 16));
  };
  const ESC = /** @type {Record<string, string>} */ ({ b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\", e: "\u001b" });
  const basic = () => {
    const multi = text.startsWith('"""', i);
    i += multi ? 3 : 1;
    if (multi && text[i] === "\n") i++; else if (multi && text.startsWith("\r\n", i)) i += 2;
    let out = "";
    for (;;) {
      if (i >= n) fail("的字符串没收尾");
      const c = text[i];
      if (multi ? text.startsWith('"""', i) : c === '"') {
        i += multi ? 3 : 1;
        // """ 后面紧跟的一两个引号算正文
        while (multi && text[i] === '"' && !text.startsWith('"""', i)) { out += '"'; i++; }
        return out;
      }
      if (!multi && (c === "\n" || c === "\r")) fail("的字符串没收尾");
      if (c === "\\") {
        i++;
        const e = text[i];
        if (multi && (e === "\n" || e === "\r" || e === " " || e === "\t")) {
          while (i < n && /[\s]/.test(text[i])) i++;
          continue;
        }
        i++;
        if (e === "u") { out += hex(4); continue; }
        if (e === "U") { out += hex(8); continue; }
        if (!(e in ESC)) fail("的转义写错了");
        out += ESC[e];
        continue;
      }
      out += c;
      i++;
    }
  };
  const literal = () => {
    const multi = text.startsWith("'''", i);
    i += multi ? 3 : 1;
    if (multi && text[i] === "\n") i++; else if (multi && text.startsWith("\r\n", i)) i += 2;
    const end = text.indexOf(multi ? "'''" : "'", i);
    if (end < 0) fail("的字符串没收尾");
    const s = text.slice(i, end);
    if (!multi && /[\r\n]/.test(s)) fail("的字符串没收尾");
    i = end + (multi ? 3 : 1);
    return s;
  };
  const key = () => {
    ws();
    let k = "";
    if (text[i] === '"') k = basic();
    else if (text[i] === "'") k = literal();
    else {
      const s = i;
      while (i < n && /[A-Za-z0-9_-]/.test(text[i])) i++;
      if (s === i) fail("这里该是一个名字");
      k = text.slice(s, i);
    }
    if (BAD_KEYS.has(k)) fail(`的名字不能叫 ${k}`);
    ws();
    return k;
  };
  const dotted = () => {
    const parts = [key()];
    while (text[i] === ".") { i++; parts.push(key()); }
    return parts;
  };
  /** @param {Record<string, any>} at @param {string[]} parts */
  const table = (at, parts) => {
    let o = at;
    for (const p of parts) {
      if (!Object.prototype.hasOwnProperty.call(o, p)) o[p] = {};
      else if (Array.isArray(o[p])) o[p] = o[p][o[p].length - 1];
      if (!o[p] || typeof o[p] !== "object") fail(`的 ${p} 已经是一个值了`);
      o = Array.isArray(o[p]) ? o[p][o[p].length - 1] : o[p];
    }
    return o;
  };
  /** @param {Record<string, any>} at @param {string[]} parts @param {unknown} v */
  const assign = (at, parts, v) => {
    const o = table(at, parts.slice(0, -1));
    const last = parts[parts.length - 1];
    if (Object.prototype.hasOwnProperty.call(o, last)) fail(`的 ${last} 写了两遍`);
    o[last] = v;
  };
  /** @returns {unknown} */
  const value = () => {
    ws();
    const c = text[i];
    if (c === '"') return basic();
    if (c === "'") return literal();
    if (c === "[") {
      i++;
      const arr = [];
      for (;;) {
        blank();
        if (text[i] === "]") { i++; return arr; }
        arr.push(value());
        blank();
        if (text[i] === ",") { i++; continue; }
        if (text[i] === "]") { i++; return arr; }
        fail("的数组没收尾");
      }
    }
    if (c === "{") {
      i++;
      /** @type {Record<string, any>} */
      const obj = {};
      blank();
      if (text[i] === "}") { i++; return obj; }
      for (;;) {
        blank();
        const ks = dotted();
        if (text[i] !== "=") fail("少了等号");
        i++;
        assign(obj, ks, value());
        blank();
        if (text[i] === ",") { i++; blank(); if (text[i] === "}") { i++; return obj; } continue; }
        if (text[i] === "}") { i++; return obj; }
        fail("的行内表没收尾");
      }
    }
    const s = i;
    while (i < n && !/[\s,\]}#]/.test(text[i])) i++;
    const tok = text.slice(s, i);
    if (tok === "true") return true;
    if (tok === "false") return false;
    if (/^[+-]?\d[\d_]*(\.\d[\d_]*)?([eE][+-]?\d+)?$/.test(tok)) return Number(tok.replace(/_/g, ""));
    if (/^0x[0-9a-fA-F_]+$/.test(tok)) return parseInt(tok.slice(2).replace(/_/g, ""), 16);
    if (/^[+-]?(inf|nan)$/.test(tok)) return tok.includes("nan") ? NaN : tok.startsWith("-") ? -Infinity : Infinity;
    if (/^\d{4}-\d{2}-\d{2}/.test(tok)) return tok; // 日期时间原样当字符串，连接器用不上
    return fail("这里该是一个值");
  };
  for (;;) {
    blank();
    if (i >= n) break;
    if (text[i] === "[") {
      const many = text[i + 1] === "[";
      i += many ? 2 : 1;
      const parts = dotted();
      if (text[i] !== "]" || (many && text[i + 1] !== "]")) fail("的表头没收尾");
      i += many ? 2 : 1;
      if (many) {
        const parent = table(root, parts.slice(0, -1));
        const last = parts[parts.length - 1];
        if (!Array.isArray(parent[last])) parent[last] = [];
        const t = {};
        parent[last].push(t);
        cur = t;
      } else cur = table(root, parts);
    } else {
      const parts = dotted();
      if (text[i] !== "=") fail("少了等号");
      i++;
      assign(cur, parts, value());
    }
    ws();
    comment();
    if (i < n && text[i] !== "\n" && text[i] !== "\r") fail("一行只能写一样东西");
  }
  return root;
}

// ---------------- 打码：清单上给人认得出是哪台就够，像密钥的部分一律不露 ----------------

const looksSecret = (/** @type {string} */ v) => /^[A-Za-z0-9_\-.+/=]{24,}$/.test(v) && /\d/.test(v) && /[A-Za-z]/.test(v) && !v.includes("/") || /^(sk|pk|ghp|gho|xox[abp]|glpat|AKIA)[-_A-Za-z0-9]{8,}/.test(v);

/** 地址里的密码、像密钥的查询参数打码 */
function maskUrl(/** @type {string} */ u) {
  return String(u)
    .replace(/^([a-z][a-z0-9+.-]*:\/\/)([^@/\s]*)@/i, (_m, p, cred) => `${p}${cred.includes(":") ? cred.split(":")[0] + ":" + MASK : MASK}@`)
    .replace(/([?&])([^=&#]+)=([^&#]*)/g, (m, sep, k, v) => (SECRET_NAME.test(k) || looksSecret(decodeURIComponentSafe(v)) ? `${sep}${k}=${MASK}` : m));
}
function decodeURIComponentSafe(/** @type {string} */ s) { try { return decodeURIComponent(s); } catch { return s; } }

/** 命令行参数里的 --api-key=xxx、--token xxx、KEY=值、带密码的地址、长得像密钥的串打码 */
function maskArgs(/** @type {unknown[]} */ args) {
  const out = [];
  let prevSecretFlag = false;
  for (const raw of args) {
    const a = String(raw);
    let m;
    if (prevSecretFlag && !a.startsWith("-")) out.push(MASK);
    else if ((m = a.match(/^(--?[A-Za-z0-9_.-]+)=(.*)$/s)) && SECRET_NAME.test(m[1])) out.push(`${m[1]}=${MASK}`);
    else if ((m = a.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s)) && (SECRET_NAME.test(m[1]) || looksSecret(m[2]))) out.push(`${m[1]}=${MASK}`);
    else if (/:\/\//.test(a)) out.push(maskUrl(a));
    else if (looksSecret(a)) out.push(MASK);
    else out.push(a.length > 160 ? a.slice(0, 160) + "…" : a);
    prevSecretFlag = /^--?[A-Za-z0-9_.-]+$/.test(a) && SECRET_NAME.test(a);
  }
  return out;
}

// ---------------- 读来源 ----------------

/** 一份值对象（env / headers）只留字符串能表达的那几种，键名不合规的丢掉 */
function strMap(/** @type {unknown} */ o) {
  /** @type {Record<string, string>} */
  const out = {};
  if (!o || typeof o !== "object" || Array.isArray(o)) return out;
  for (const [k, v] of Object.entries(o)) {
    if (BAD_KEYS.has(k) || k.length > 200) continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = String(v);
  }
  return out;
}

/**
 * 各家一条连接器的写法规整成同一个样子（带值，只在服务端用）
 * @param {string} name @param {any} e @param {"json"|"toml"} format
 * @returns {null | {name: string, transport: "stdio"|"http", command: string, args: string[], env: Record<string,string>, url: string, headers: Record<string,string>, note: string}}
 */
function entryOf(name, e, format) {
  if (!e || typeof e !== "object" || Array.isArray(e)) return null;
  const url = typeof e.url === "string" ? e.url.trim() : typeof e.serverUrl === "string" ? e.serverUrl.trim() : "";
  const command = typeof e.command === "string" ? e.command.trim() : "";
  const type = String(e.type || e.transport || "").toLowerCase();
  const remote = !!url && (!command || /http|sse/.test(type));
  if (!remote && !command) return null;
  const notes = [];
  if (remote && /sse/.test(type)) notes.push("老式 SSE 连接，可能连不上");
  if (format === "toml" && e.bearer_token_env_var) notes.push("令牌放在环境变量里，导进来后要自己填");
  if (format === "toml" && Array.isArray(e.env_vars) && e.env_vars.length) notes.push("有几项环境变量没写在文件里，导进来后要自己填");
  if (e.enabled === false || e.disabled === true) notes.push("在原来那边是关着的");
  return {
    name,
    transport: remote ? "http" : "stdio",
    command: remote ? "" : command,
    args: remote ? [] : (Array.isArray(e.args) ? e.args : []).filter((a) => ["string", "number", "boolean"].includes(typeof a)).map(String),
    env: remote ? {} : strMap(e.env),
    url: remote ? url : "",
    headers: remote ? strMap(format === "toml" ? e.http_headers || e.headers : e.headers) : {},
    note: notes.join("；"),
  };
}

/**
 * 读一个来源，回它带值的连接器表。读不到回 null，读到了但读不懂抛错（错误里不带文件内容）
 * @param {Source} src
 */
function readSource(src) {
  let st;
  try { st = fs.statSync(src.file); } catch { return null; }
  if (!st.isFile()) return null;
  if (st.size > MAX_BYTES) throw new Error("文件太大，没读");
  let text = fs.readFileSync(src.file, "utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  /** @type {any} */
  let block;
  try {
    // 整份解析是免不了的，但只留这一个键：别的字段当场丢掉，不往下传
    block = src.format === "toml" ? parseToml(text)[src.key] : (JSON.parse(text) || {})[src.key];
  } catch (e) {
    // JSON 的报错原文会回显一段文件内容，不能照抄；TOML 这边自己写的只带行号
    throw new Error(src.format === "toml" ? `格式读不懂（${String((e && /** @type {any} */ (e).message) || "").slice(0, 40)}）` : "格式读不懂");
  }
  text = "";
  /** @type {Map<string, NonNullable<ReturnType<typeof entryOf>>>} */
  const out = new Map();
  if (!block || typeof block !== "object" || Array.isArray(block)) return out;
  for (const [name, e] of Object.entries(block).slice(0, 200)) {
    if (BAD_KEYS.has(name)) continue;
    const x = entryOf(name, e, src.format);
    if (x) out.set(name, x);
  }
  return out;
}

/** 名字换成本项目认的写法（字母、数字、- 和 _） */
function safeName(/** @type {string} */ name) {
  return String(name).replace(/[^A-Za-z0-9_-]+/g, "-").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "imported";
}

/**
 * 页面看的那份清单：一个值都没有
 * @param {{env?: NodeJS.ProcessEnv, platform?: string, taken?: string[]}} [o] taken：已经有的连接器名，撞名的标出来
 */
function list({ env = process.env, platform = process.platform, taken = [] } = {}) {
  const have = new Set(taken);
  const home = env.OWB_IMPORT_HOME || os.homedir();
  const shown = (/** @type {string} */ f) => (f.startsWith(home + path.sep) ? "~" + f.slice(home.length) : f);
  const out = { sources: /** @type {any[]} */ ([]), items: /** @type {any[]} */ ([]) };
  for (const src of sources(env, platform)) {
    /** @type {any} */
    const row = { id: src.id, label: src.label, path: shown(src.file), found: false, count: 0 };
    try {
      const got = readSource(src);
      if (got) {
        row.found = true;
        row.count = got.size;
        for (const x of got.values()) {
          const as = safeName(x.name);
          out.items.push({
            source: src.id, source_label: src.label, name: x.name, as, exists: have.has(as),
            transport: x.transport,
            command: x.command, args: maskArgs(x.args),
            url: x.url ? maskUrl(x.url) : "",
            env_keys: Object.keys(x.env), header_keys: Object.keys(x.headers),
            note: x.note,
          });
        }
      }
    } catch (e) {
      row.found = true;
      row.error = String((e && /** @type {any} */ (e).message) || e).slice(0, 80);
    }
    out.sources.push(row);
  }
  return out;
}

/**
 * 服务端真导入时取值：按来源和原名再读一遍文件
 * @param {string} sourceId @param {string} name @param {{env?: NodeJS.ProcessEnv, platform?: string}} [o]
 */
function pick(sourceId, name, { env = process.env, platform = process.platform } = {}) {
  const src = sources(env, platform).find((s) => s.id === sourceId);
  if (!src) throw new Error("不认得这个来源");
  const got = readSource(src);
  const x = got && got.get(name);
  if (!x) throw new Error(`${src.label} 里没找到「${name}」，可能刚被改过，刷新一下再选`);
  return x;
}

module.exports = { sources, parseToml, list, pick, maskArgs, maskUrl, safeName, entryOf, _internals: { readSource, strMap } };
