// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 OpenWorkBuddy Contributors · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 把这台机器上 Claude Code、Codex 在终端里留下的会话导进任务历史。
 *
 * 读哪儿（测试和特殊部署用环境变量改）：
 *   Claude Code：OPENWORKBUDDY_IMPORT_CLAUDE_DIR；没设就是 $CLAUDE_CONFIG_DIR（或 ~/.claude）/projects/<编码过的文件夹>/<会话 id>.jsonl
 *   Codex      ：OPENWORKBUDDY_IMPORT_CODEX_DIR；没设就是 $CODEX_HOME（或 ~/.codex）/sessions/年/月/日/rollout-*.jsonl
 * 原文件只读：不改、不挪、不删。
 *
 * 几条规矩：
 *   - 数条数只 readdir + stat，带缓存，首页不能因为它慢一拍；真读文件只在列清单、导入的时候。
 *   - 解析容错：坏行跳过，不认识的类型不管。只留用户的话和助理的话，工具调用压成一行「在干什么」，
 *     工具输出只留一小段预览——几 MB 的命令输出不进会话。
 *   - 本项目自己拉起的 claude 也写在 ~/.claude 里，那些不算「本机的会话」，不列：
 *     ① 落在本项目自己建的目录下的（工作区、项目区、组织根、个人目录、引擎自测的临时目录）；
 *     ② 引擎会话 id 记在本项目会话里的（engine_session / engine_sessions）。
 *   - 同一条导两次不出两份：按「来源:原 id」记一本账，账上那条会话还在就不再导。
 *   - 谁能导由路由那层管（只有这台机器的主人），这里不认人。
 */
const fs = require("fs");
const fsp = fs.promises;
const os = require("os");
const path = require("path");
const { dataPath } = require("../../platform/paths");
const store = require("../../platform/store");

const SOURCES = {
  "claude-code": { name: "Claude Code" },
  codex: { name: "Codex" },
};
const SOURCE_IDS = Object.keys(SOURCES);

const CLAUDE_FILE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;
const ROLLOUT_RE = /^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
// 本项目会话里记引擎会话 id 的那两个键。只认这两个键底下的 id：会话正文里随便出现的一串 uuid 不算
const ENGINE_KEY_RE = /"engine_sessions?"\s*:\s*(\{[^{}]*\}|"[^"]*")/g;

const HEAD_BYTES = 1024 * 1024;       // 列清单只读开头这么多：标题、文件夹都在最前面
const MAX_LINE = 8 * 1024 * 1024;     // 超过这么长的一行（多半是整份文件读进来的工具结果）整行跳过
const MSG_CAP = 8000;                 // 一句话最多留这么多字
const PREVIEW = 300;                  // 工具输出只留这么多字的预览
const HIST_CAP = 80000;               // 带给模型的历史最多这么多字，留最近的
const TRANSCRIPT_CAP = 600000;        // 回放记录最多这么多字，留最近的
const COUNT_TTL = 10000;              // 条数缓存多久
const WARM_MAX = 400;                 // 后台每趟最多预读多少个小文件（认出只有标题、没有话的空会话）
const WARM_SIZE = 64 * 1024;

/* ---------- 去哪儿读 ---------- */

function claudeRoot() {
  if (process.env.OPENWORKBUDDY_IMPORT_CLAUDE_DIR) return path.resolve(process.env.OPENWORKBUDDY_IMPORT_CLAUDE_DIR);
  const base = process.env.CLAUDE_CONFIG_DIR ? path.resolve(process.env.CLAUDE_CONFIG_DIR) : path.join(os.homedir(), ".claude");
  return path.join(base, "projects");
}
function codexRoot() {
  if (process.env.OPENWORKBUDDY_IMPORT_CODEX_DIR) return path.resolve(process.env.OPENWORKBUDDY_IMPORT_CODEX_DIR);
  const base = process.env.CODEX_HOME ? path.resolve(process.env.CODEX_HOME) : path.join(os.homedir(), ".codex");
  const root = path.join(base, "sessions");
  // 本项目自己的 codex 跑在隔离运行窝里；CODEX_HOME 恰好指着它的话，那里头全是本项目自己跑的
  return root === dataPath("data", "runtime", "codex", "sessions") ? "" : root;
}
const rootOf = (source) => (source === "claude-code" ? claudeRoot() : codexRoot());

/** Claude Code 把工作目录编成文件夹名的规则：字母数字以外一律换成 - */
const encodeCwd = (p) => String(p || "").replace(/[^a-zA-Z0-9]/g, "-");

/** 本项目自己建的那些根（编码后）。用户自己选的工作区根不在里面：那里面也可能有他在终端里开的会话 */
function ownRoots() {
  const list = [dataPath("workspace"), dataPath("projects"), dataPath("accounts")];
  try { list.push(require("../account/org").tenantsDir()); } catch {}
  try { list.push(...require("../account/spaces").homes()); } catch {}
  const out = new Set();
  for (const p of list) {
    if (!p) continue;
    out.add(encodeCwd(path.resolve(p)));
    try { out.add(encodeCwd(fs.realpathSync(p))); } catch {}
  }
  return [...out];
}
const ownedDir = (name, roots) =>
  /-owb-(engine-test|ask)-/.test(name) || roots.some((e) => name === e || name.startsWith(e + "-"));

/* ---------- 小工具 ---------- */

async function pool(list, n, fn) {
  let i = 0;
  const work = async () => { while (i < list.length) { const k = i++; await fn(list[k], k); } };
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, work));
}
const tick = () => new Promise((r) => setImmediate(r));
const oneLine = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
function tailText(v, n) {
  const t = oneLine(v);
  return t.length > n ? "…" + t.slice(-(n - 1)) : t;
}
function cap(s, n) {
  const t = String(s || "");
  return t.length > n ? t.slice(0, n) + `\n…（后面还有 ${t.length - n} 字没导进来）` : t;
}
function tryJson(s) {
  if (s && typeof s === "object") return s;
  if (typeof s !== "string" || !/^\s*[{[]/.test(s)) return null;
  try { return JSON.parse(s); } catch { return null; }
}

/**
 * 一行一行读 jsonl。按块读、按换行切，整份文件不进内存；超长的行整行跳过不攒。
 * onLine 返回 false 就提前收手。complete = 一直读到了文件尾
 */
async function eachLine(file, onLine, { maxBytes = Infinity, maxLine = MAX_LINE } = {}) {
  const fh = await fsp.open(file, "r");
  const buf = Buffer.allocUnsafe(256 * 1024);
  let parts = [];
  let partLen = 0;
  let skipping = false;
  let total = 0;
  try {
    for (;;) {
      if (total >= maxBytes) return { complete: false };
      const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, maxBytes - total), null);
      if (!bytesRead) break;
      total += bytesRead;
      // 只看这一回读进来的那段：buf 是复用的，后半截可能还是上一回的旧字节
      const view = buf.subarray(0, bytesRead);
      let start = 0;
      for (;;) {
        const nl = view.indexOf(10, start);
        if (nl < 0) {
          if (!skipping) {
            const rest = view.subarray(start);
            if (partLen + rest.length > maxLine) { skipping = true; parts = []; partLen = 0; }
            // 复制一份：下一回读会把 buf 盖掉
            else if (rest.length) { parts.push(Buffer.from(rest)); partLen += rest.length; }
          }
          break;
        }
        if (skipping) skipping = false;
        else {
          const piece = view.subarray(start, nl);
          const line = parts.length ? Buffer.concat([...parts, piece], partLen + piece.length).toString("utf8") : piece.toString("utf8");
          parts = [];
          partLen = 0;
          if (onLine(line) === false) return { complete: false };
        }
        start = nl + 1;
      }
    }
    if (!skipping && partLen && onLine(Buffer.concat(parts, partLen).toString("utf8")) === false) return { complete: false };
    return { complete: true };
  } finally {
    await fh.close().catch(() => {});
  }
}
/** 每行当一个 JSON 对象读；坏行、空行、不是对象的行都跳过 */
function jsonLines(file, onObj, opt) {
  return eachLine(file, (line) => {
    if (!line || !line.trim()) return undefined;
    let o;
    try { o = JSON.parse(line); } catch { return undefined; }
    return o && typeof o === "object" && !Array.isArray(o) ? onObj(o) : undefined;
  }, opt);
}

/* ---------- 工具调用压成一行人话 ---------- */

const VERB = {
  run_shell: "命令", read_file: "读", write_file: "写", edit_file: "改", search_files: "搜文件", find_files: "找文件",
  list_files: "列目录", fetch_url: "抓", web_search: "搜", todo_write: "进度", shell_output: "看后台输出",
  shell_kill: "停后台", look_at_image: "看图", Task: "派子任务", Agent: "派子任务",
};
const CLAUDE_TOOLS = {
  Bash: "run_shell", BashOutput: "shell_output", KillShell: "shell_kill", KillBash: "shell_kill",
  Read: "read_file", Write: "write_file", Edit: "edit_file", MultiEdit: "edit_file", NotebookEdit: "edit_file",
  Grep: "search_files", Glob: "find_files", LS: "list_files", WebFetch: "fetch_url", WebSearch: "web_search", TodoWrite: "todo_write",
};
const OWN_PREFIX = /^(?:mcp__openworkbuddy__|openworkbuddy\.)(?=.)/;

function purposeOf(input) {
  if (!input || typeof input !== "object") return "";
  const pick = input.file_path || input.notebook_path || input.path || input.command || input.pattern || input.url || input.query || input.description || input.prompt;
  return pick ? oneLine(pick).slice(0, 80) : "";
}
function todoCount(list, doneWord) {
  const t = Array.isArray(list) ? list : [];
  return t.length ? `${t.filter((x) => x && x.status === doneWord).length}/${t.length}` : "";
}
function toolPart(id, name, purpose) {
  const verb = VERB[name] || String(name || "工具").replace(/^mcp[_:]+/, "").replace(/_/g, " ").slice(0, 20);
  const obj = name === "run_shell" ? tailText(String(purpose || "").split("\n")[0], 56)
    : name === "web_search" || name === "search_files" ? (purpose ? "「" + tailText(purpose, 40) + "」" : "")
    : tailText(purpose, 46);
  return { id: String(id || ""), name, purpose: oneLine(purpose).slice(0, 80), title: obj ? verb + " " + obj : verb };
}
function claudeTool(b) {
  const raw = String(b.name || "");
  const name = CLAUDE_TOOLS[raw] || raw.replace(OWN_PREFIX, "");
  const input = b.input && typeof b.input === "object" ? b.input : {};
  const purpose = name === "todo_write" ? todoCount(input.todos, "completed")
    : raw === "Task" || raw === "Agent" ? oneLine(input.description || input.prompt).slice(0, 80)
    : purposeOf(input);
  return toolPart(b.id, name, purpose);
}
function shellCmd(c) {
  if (Array.isArray(c)) {
    if (c.length >= 3 && /(^|\/)(ba|z)?sh$/.test(String(c[0])) && /^-l?c$/.test(String(c[1]))) return String(c[2]);
    return c.map(String).join(" ");
  }
  return String(c || "");
}
const patchFiles = (s) => [...String(s || "").matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) => m[1].trim()).join(", ");
function codexTool(p) {
  const id = p.call_id || p.id || "";
  if (p.type === "local_shell_call") return toolPart(id, "run_shell", shellCmd(p.action && p.action.command));
  if (p.type === "web_search_call") {
    const a = p.action || {};
    return toolPart(id, "web_search", a.query || (Array.isArray(a.queries) ? a.queries[0] : "") || "");
  }
  const name = String(p.name || "");
  if (p.type === "custom_tool_call") {
    if (name === "apply_patch") return toolPart(id, "edit_file", patchFiles(p.input));
    return toolPart(id, name.replace(OWN_PREFIX, "") || "工具", purposeOf(tryJson(p.input)) || oneLine(p.input).slice(0, 80));
  }
  const args = tryJson(p.arguments) || {};
  if (name === "shell" || name === "container.exec") return toolPart(id, "run_shell", shellCmd(args.command));
  if (name === "exec_command") return toolPart(id, "run_shell", String(args.cmd || args.command || ""));
  if (name === "shell_command") return toolPart(id, "run_shell", String(args.command || ""));
  if (name === "apply_patch") return toolPart(id, "edit_file", patchFiles(args.input || args.patch));
  if (name === "update_plan") return toolPart(id, "todo_write", todoCount(args.plan, "completed"));
  if (name === "view_image") return toolPart(id, "look_at_image", String(args.path || ""));
  return toolPart(id, name.replace(OWN_PREFIX, "") || "工具", purposeOf(args));
}
function codexOutput(out) {
  let text = "";
  let isError = false;
  if (typeof out === "string") {
    text = out;
    const j = /^\s*\{/.test(out) ? tryJson(out) : null;
    if (j && typeof j === "object") {
      if (typeof j.output === "string") text = j.output;
      if (j.metadata && j.metadata.exit_code != null && Number(j.metadata.exit_code) !== 0) isError = true;
    }
    const m = /^Exit code:\s*(-?\d+)/m.exec(text.slice(0, 200));
    if (m && m[1] !== "0") isError = true;
  } else if (out && typeof out === "object") {
    text = typeof out.content === "string" ? out.content : Array.isArray(out.content) ? out.content.map((c) => (c && c.text) || "").join("\n") : "";
    if (out.success === false) isError = true;
  }
  return { text, isError };
}
function textOfResult(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (c && typeof c === "object" ? c.text || (c.type === "image" ? "[图片]" : "") : String(c || ""))).join("\n");
  return content == null ? "" : String(content);
}

/* ---------- 一段对话：用户一句、助理一段（话 + 工具卡） ---------- */

function makeConv() {
  const turns = [];
  const byId = new Map();
  const last = () => turns[turns.length - 1];
  const asst = (at) => {
    const l = last();
    if (l && l.role === "assistant") return l;
    const a = { role: "assistant", parts: [], at };
    turns.push(a);
    return a;
  };
  return {
    turns,
    user(text, at) {
      const l = last();
      if (l && l.role === "user") l.text += "\n\n" + text;
      else turns.push({ role: "user", text, at });
    },
    say(text, at) {
      const a = asst(at);
      const p = a.parts[a.parts.length - 1];
      if (p && p.kind === "text") p.text += "\n\n" + text;
      else a.parts.push({ kind: "text", text });
    },
    tool(t, at) {
      const part = { kind: "tool", ...t, at };
      asst(at).parts.push(part);
      if (t.id) byId.set(t.id, part);
    },
    result(id, text, isError, at) {
      const part = byId.get(String(id || ""));
      if (!part || part.done) return;
      const s = String(text || "");
      Object.assign(part, { done: true, preview: s.slice(0, PREVIEW), cut: s.length > PREVIEW, isError: !!isError, resAt: at });
    },
  };
}

/* ---------- Claude Code ---------- */

/** 用户那句话洗一遍：系统提醒去掉，斜杠命令还原成「/命令 参数」，本地命令的输出不算话 */
function cleanClaudeText(raw) {
  const s = String(raw || "").replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "");
  const cmd = /<command-name>\s*([^<]*?)\s*<\/command-name>/.exec(s);
  if (cmd) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(s);
    const name = cmd[1].startsWith("/") ? cmd[1] : "/" + cmd[1];
    return { text: name + (args && args[1].trim() ? " " + args[1].trim() : ""), slash: true };
  }
  const bash = /<bash-input>([\s\S]*?)<\/bash-input>/.exec(s);
  if (bash) return { text: "! " + bash[1].trim(), slash: false };
  if (/<(bash-stdout|bash-stderr|local-command-stdout|local-command-stderr)>/.test(s)) return { text: "" };
  const t = s.replace(/<command-message>[\s\S]*?<\/command-message>/g, "").trim();
  if (/^\[Request interrupted by user[^\]]*\]$/.test(t)) return { text: "" };
  return { text: t, slash: false };
}

/**
 * 读一条 Claude Code 会话。head=true 只为列清单：读开头、拿到标题和文件夹就收手。
 * @returns {{title:string, cwd:string, turns:any[], complete:boolean, empty:boolean}}
 */
async function parseClaude(file, { dirName = "", head = false } = {}) {
  const conv = makeConv();
  let summary = "", firstUser = "", firstSlash = "", cwd = "", cwdAny = "", saidSomething = false;
  const seen = new Set(); // 同一条消息拆成几行写、或者整条重写一遍的，都只算一次
  const res = await jsonLines(file, (o) => {
    if (typeof o.cwd === "string" && o.cwd) {
      if (!cwdAny) cwdAny = o.cwd;
      if (!cwd && dirName && encodeCwd(o.cwd) === dirName) cwd = o.cwd;
    }
    if (o.type === "summary") {
      if (!summary && typeof o.summary === "string") summary = oneLine(o.summary);
      return undefined;
    }
    if (o.type !== "user" && o.type !== "assistant") return undefined;
    if (o.isMeta || o.isSidechain || o.isCompactSummary || o.isApiErrorMessage) return undefined;
    const m = o.message;
    if (!m || typeof m !== "object") return undefined;
    const at = Date.parse(o.timestamp || "") || 0;
    const blocks = typeof m.content === "string" ? [{ type: "text", text: m.content }] : Array.isArray(m.content) ? m.content : [];
    if (o.type === "user") {
      const texts = [];
      let slash = false;
      for (const b of blocks) {
        if (!b || typeof b !== "object") continue;
        if (b.type === "text") {
          const c = cleanClaudeText(b.text);
          if (c.text) { texts.push(c.text); if (c.slash) slash = true; }
        } else if (b.type === "image") texts.push("[图片]");
        else if (b.type === "document") texts.push("[文件]");
        else if (b.type === "tool_result" && !head) conv.result(b.tool_use_id, textOfResult(b.content), !!b.is_error, at);
      }
      const text = texts.join("\n").trim();
      if (!text) return undefined;
      if (slash) { if (!firstSlash) firstSlash = text; }
      else if (!firstUser) firstUser = text;
      if (!head) conv.user(text, at);
      else if (firstUser && cwdAny) return false;
      return undefined;
    }
    if (m.model === "<synthetic>") return undefined;
    for (const b of blocks) {
      if (!b || typeof b !== "object") continue;
      if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
        saidSomething = true;
        if (head) continue;
        const key = (m.id || "") + "\u0000" + b.text;
        if (m.id && seen.has(key)) continue;
        if (m.id) seen.add(key);
        conv.say(b.text.trim(), at);
      } else if (b.type === "tool_use" && !head) {
        const key = "\u0001" + (b.id || "");
        if (b.id && seen.has(key)) continue;
        if (b.id) seen.add(key);
        conv.tool(claudeTool(b), at);
      }
    }
    return undefined;
  }, { maxBytes: head ? HEAD_BYTES : Infinity });
  return {
    title: summary || firstUser || firstSlash,
    cwd: cwd || cwdAny,
    turns: conv.turns,
    complete: res.complete,
    // 一句正经话都没有（只有标题行、只敲过 /clear 这类命令又没回话）= 空会话，不列
    empty: res.complete && !firstUser && !(firstSlash && saidSomething),
  };
}

/* ---------- Codex ---------- */

const WRAPPED = new Set(["session_meta", "turn_context", "response_item", "event_msg", "compacted"]);
// Codex 每一轮塞给模型的环境说明、项目说明，不是用户说的话
const CODEX_NOT_USER = /^\s*(<environment_context>|<user_instructions>|<permissions instructions>|# AGENTS\.md instructions)/;

/** 读一条 Codex 会话（新的 {timestamp,type,payload} 格式和老的裸格式都认） */
async function parseCodex(file, { head = false } = {}) {
  const items = [];
  let metaCwd = "", ctxCwd = "", envCwd = "", firstUser = "", evUser = false, evAsst = false;
  const userText = (t) => {
    if (!firstUser) firstUser = t;
  };
  const res = await jsonLines(file, (o) => {
    let kind, p;
    if (WRAPPED.has(o.type) && o.payload && typeof o.payload === "object") { kind = o.type; p = o.payload; }
    else if (o.record_type) return undefined;
    else if (!o.type && typeof o.id === "string") { kind = "session_meta"; p = o; }
    else { kind = "response_item"; p = o; }
    const at = Date.parse(o.timestamp || p.timestamp || "") || 0;
    if (kind === "session_meta") {
      if (!metaCwd && typeof p.cwd === "string") metaCwd = p.cwd;
      return undefined;
    }
    if (kind === "turn_context") {
      if (!ctxCwd && typeof p.cwd === "string") ctxCwd = p.cwd;
      return undefined;
    }
    if (kind === "event_msg") {
      if (p.type === "user_message" && typeof p.message === "string") {
        const imgs = Array.isArray(p.images) && p.images.length ? "\n[图片]" : "";
        const t = CODEX_NOT_USER.test(p.message) ? "" : (p.message.trim() + imgs).trim();
        if (t) { evUser = true; userText(t); items.push({ k: "user", ev: true, text: t, at }); }
      } else if (p.type === "agent_message" && typeof p.message === "string" && p.message.trim()) {
        evAsst = true;
        if (!head) items.push({ k: "asst", ev: true, text: p.message.trim(), at });
      }
    } else if (kind === "response_item") {
      if (p.type === "message") {
        if (p.role !== "user" && p.role !== "assistant") return undefined;
        const parts = Array.isArray(p.content) ? p.content : typeof p.content === "string" ? [{ type: "input_text", text: p.content }] : [];
        const texts = [];
        for (const c of parts) {
          if (!c || typeof c !== "object") continue;
          if (typeof c.text === "string") {
            if (p.role === "user" && CODEX_NOT_USER.test(c.text)) {
              const env = /<cwd>([^<]+)<\/cwd>/.exec(c.text);
              if (env && !envCwd) envCwd = env[1].trim();
              continue;
            }
            if (c.text.trim()) texts.push(c.text.trim());
          } else if (c.type === "input_image") texts.push("[图片]");
        }
        const t = texts.join("\n").trim();
        if (t && p.role === "user") { userText(t); items.push({ k: "user", ev: false, text: t, at }); }
        else if (t && !head) items.push({ k: "asst", ev: false, text: t, at });
      } else if (head) {
        return undefined;
      } else if (["function_call", "custom_tool_call", "local_shell_call", "web_search_call"].includes(p.type)) {
        items.push({ k: "tool", t: codexTool(p), at });
      } else if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
        const r = codexOutput(p.output);
        items.push({ k: "result", id: p.call_id || "", text: r.text.slice(0, PREVIEW + 1), isError: r.isError, at });
      }
    }
    if (head && firstUser && metaCwd) return false;
    return undefined;
  }, { maxBytes: head ? HEAD_BYTES : Infinity });
  // 新版两边都记：event_msg 里是用户原话，response_item 里还夹着塞给模型的说明。哪边有就用哪边，别两份都算
  const conv = makeConv();
  for (const it of items) {
    if (it.k === "user") { if (it.ev === evUser) conv.user(it.text, it.at); }
    else if (it.k === "asst") { if (it.ev === evAsst) conv.say(it.text, it.at); }
    else if (it.k === "tool") conv.tool(it.t, it.at);
    else conv.result(it.id, it.text, it.isError, it.at);
  }
  return { title: firstUser, cwd: metaCwd || ctxCwd || envCwd, turns: conv.turns, complete: res.complete, empty: res.complete && !firstUser };
}

/* ---------- 拼成本项目的一条会话 ---------- */

const note = (text) => ({ type: "status", notice: true, text, depth: 0 });
const entryLen = (h) => String(h.content || h.text || "").length;

/**
 * @returns 会话对象；一句用户话都没有就是 null
 */
function toSession({ source, id, file, cwd, title, turns, mtimeMs, owner }) {
  const label = SOURCES[source].name;
  // 开头的助理话、什么都没有的助理回合去掉；去完相邻的两句用户话并成一句
  const ts = [];
  for (const t of turns) {
    if (t.role === "assistant") {
      if (t.parts.length && ts.length) ts.push(t);
      continue;
    }
    const prev = ts[ts.length - 1];
    if (prev && prev.role === "user") prev.text += "\n\n" + t.text;
    else ts.push({ ...t });
  }
  if (!ts.length) return null;
  const when = (t) => t.at || mtimeMs || Date.now();
  const hist = [];
  const trans = [];
  let n = 0;
  for (const t of ts) {
    if (t.role === "user") {
      const text = cap(t.text, MSG_CAP);
      hist.push({ role: "user", content: text });
      trans.push({ type: "user", text, at: when(t) });
      continue;
    }
    const said = t.parts.filter((p) => p.kind === "text").map((p) => cap(p.text, MSG_CAP)).join("\n\n");
    const tools = t.parts.filter((p) => p.kind === "tool").map((p) => p.title);
    let used = tools.length ? "〔用过的工具〕" + tools.join("；") : "";
    if (used.length > 300) used = used.slice(0, 299) + "…";
    hist.push({ role: "assistant", text: [said, used].filter(Boolean).join("\n\n"), toolCalls: [] });
    const events = [];
    for (const p of t.parts) {
      if (p.kind === "text") { events.push({ type: "text", delta: cap(p.text, MSG_CAP) }); continue; }
      const tid = p.id || `imp-${++n}`;
      events.push({ type: "tool_use", id: tid, name: p.name, title: p.title, purpose: p.purpose, depth: 0, at: p.at || when(t) });
      events.push({ type: "tool_result", id: tid, name: p.name, isError: !!p.isError, preview: p.preview || "", ...(p.cut ? { cut: true } : {}), depth: 0, at: p.resAt || p.at || when(t) });
    }
    trans.push({ type: "assistant", events, at: when(t) });
  }
  const unanswered = ts[ts.length - 1].role === "user";
  if (unanswered) hist.push({ role: "assistant", text: "（这一句在原来那边没有收到回复）", toolCalls: [] });

  // 带给模型的历史：留最近的，开头必须是用户那句
  let size = 0;
  let from = hist.length;
  while (from > 0 && size + entryLen(hist[from - 1]) <= HIST_CAP) size += entryLen(hist[--from]);
  if (from === hist.length) from = Math.max(0, hist.length - 2);
  while (from < hist.length && hist[from].role !== "user") from++;
  const history = hist.slice(from);

  // 回放记录同理；砍掉了几轮要说一声
  size = 0;
  let tf = trans.length;
  while (tf > 0) {
    const len = JSON.stringify(trans[tf - 1]).length;
    if (size + len > TRANSCRIPT_CAP && tf < trans.length) break;
    size += len;
    tf--;
  }
  while (tf < trans.length && trans[tf].type !== "user") tf++;
  const dropped = trans.slice(0, tf).filter((e) => e.type === "user").length;
  const transcript = trans.slice(tf);
  const tail = [];
  if (unanswered) tail.push(note("这一句在原来那边没有收到回复"));
  const folder = cwd ? path.basename(cwd).slice(0, 24) : "";
  tail.push(note(folder ? `从本机 ${label} 导入 · 文件夹 ${folder} · 可以接着聊` : `从本机 ${label} 导入，可以接着聊`));
  if (dropped) tail.push(note(`更早的 ${dropped} 轮太长，没导进来`));
  const lastEntry = transcript[transcript.length - 1];
  if (lastEntry && lastEntry.type === "assistant") lastEntry.events.push(...tail);
  else transcript.push({ type: "assistant", events: tail, at: mtimeMs || Date.now() });

  return {
    title: oneLine(title).slice(0, 50) || `本机 ${label} 会话`,
    ...(owner ? { user: owner } : {}),
    lane: "cli",
    updated_at: new Date(mtimeMs || Date.now()).toISOString(),
    history,
    transcript,
    imported: { source, id, cwd: cwd || "", file, at: Date.now(), hist: history.length },
  };
}

/* ---------- 接着聊：用哪根线、在哪个文件夹 ---------- */

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
/** 记下的 rollout 还在 Codex 会话目录里、名字也对得上，才拿去复制 */
function rolloutOk(file, id) {
  const root = codexRoot();
  if (!root || typeof file !== "string" || !path.isAbsolute(file)) return false;
  const abs = path.resolve(file);
  if (!abs.startsWith(root + path.sep) || !ROLLOUT_RE.test(path.basename(abs)) || !abs.endsWith(id + ".jsonl")) return false;
  try { return fs.statSync(abs).isFile(); } catch { return false; }
}

/**
 * 导入的会话这一轮怎么接着跑。没导入过的会话原样放行。
 *
 *   · 内置引擎：前面的对话当背景，在任务文件夹里干活
 *   · 不是这台机器的主人：原来那个文件夹不给用，在任务文件夹里接着聊
 *   · 原来的文件夹没了：同上
 *   · 主人 + 文件夹在 + 用的正是原来那个引擎、还没接着聊过：接上原来那根线
 *     （Claude Code 分出一根新的，Codex 先复制一份进隔离运行窝，原文件都不动）
 *   · 别的情况（换了引擎、中途跑过别的）：前面的对话当背景，还在原来的文件夹里
 *
 * 换了一种跑法才说一声；跑法记在 sess.imported.mode 里，随会话存盘
 *
 * @returns {{engineSession:string|null, engineImport:object|null, notice:string}}
 */
function continuePlan(sess, { engine, owner, engineSession } = {}) {
  const imp = sess && sess.imported;
  if (!imp || typeof imp !== "object" || !SOURCES[imp.source] || typeof imp.id !== "string") {
    return { engineSession: engineSession || null, engineImport: null, notice: "" };
  }
  const name = engine === "claude-code" ? "Claude Code" : engine === "codex" ? "Codex" : "本机引擎";
  const history = Array.isArray(sess.history) ? sess.history : [];
  let key;
  let plan;
  if (!engine || engine === "builtin") {
    key = "builtin";
    plan = { engineSession: null, engineImport: null, notice: "现在用的是内置引擎，前面的对话当背景带过去，在任务文件夹里干活" };
  } else if (!owner) {
    key = "guest";
    plan = { engineSession: imp.mode === "guest" ? engineSession || null : null, engineImport: null, notice: "原来的文件夹只有导入它的人能用，这次在任务文件夹里接着聊" };
  } else if (!(typeof imp.cwd === "string" && path.isAbsolute(imp.cwd) && isDir(imp.cwd))) {
    key = "nocwd";
    plan = { engineSession: imp.mode === "nocwd" ? engineSession || null : null, engineImport: null, notice: "原来的文件夹找不到了，这次在任务文件夹里接着聊，前面的对话当背景" };
  } else if (engineSession && !(engine === "claude-code" && engineSession === imp.id) && imp.mode !== "guest" && imp.mode !== "nocwd") {
    // 已经在原来的文件夹里接着聊过了：照常续自己那根线
    key = imp.mode || "resume";
    const ei = { cwd: imp.cwd };
    if (engine === "codex" && engineSession === imp.id && rolloutOk(imp.file, imp.id)) ei.rollout = imp.file;
    plan = { engineSession, engineImport: ei, notice: "" };
  } else if (engine === imp.source && history.length > (Number(imp.hist) || 0) && history.slice(Number(imp.hist) || 0).every((h) => h && h.role === "user")
    && (engine === "claude-code" || rolloutOk(imp.file, imp.id))) {
    key = "resume";
    plan = {
      engineSession: imp.id,
      engineImport: engine === "claude-code" ? { cwd: imp.cwd, fork: true } : { cwd: imp.cwd, rollout: imp.file },
      notice: `接着原来那条 ${name} 会话往下聊，还在原来的文件夹里干活`,
    };
  } else {
    key = "context";
    plan = { engineSession: null, engineImport: { cwd: imp.cwd }, notice: `前面的对话当背景带给 ${name}，还在原来的文件夹里干活` };
  }
  if (imp.mode === key) plan.notice = "";
  imp.mode = key;
  return plan;
}

/* ---------- 找、数、列、导 ---------- */

/**
 * @param deps.sessionFile (id) => 本项目会话文件的路径（跟 server.js 的 sessFile 同一个）
 * @param deps.sessionDirs 本项目存会话的目录（网页会话、IM 会话），从里面认出本项目自己跑过的引擎会话
 * @param deps.ledgerFile  导入账本
 */
function createSessionImporter(deps = {}) {
  const sessionFile = deps.sessionFile || ((id) => path.join(dataPath("data", "sessions"), String(id).replace(/[^\w-]/g, "_") + ".json"));
  const sessionDirs = deps.sessionDirs || [dataPath("data", "sessions"), dataPath("data", "im-sessions")];
  const ledgerFile = deps.ledgerFile || dataPath("data", "import-ledger.json");
  const sessionExists = (sid) => { try { return fs.existsSync(sessionFile(sid)); } catch { return false; } };

  /* 账本：{ v:1, items: { "<来源>:<原 id>": { sid, at } } } */
  let ledger = null;
  let ledgerWrite = Promise.resolve();
  const book = () => {
    if (!ledger) {
      const j = store.readJson(ledgerFile, null);
      ledger = j && j.items && typeof j.items === "object" && !Array.isArray(j.items) ? j : { v: 1, items: {} };
    }
    return ledger;
  };
  /** 去重只认这一处：账上有、而且那条会话还在 */
  const alreadyImported = (source, id) => {
    const e = book().items[source + ":" + id];
    return !!(e && e.sid && sessionExists(e.sid));
  };
  const remember = (source, id, sid) => {
    book().items[source + ":" + id] = { sid, at: new Date().toISOString() };
    const snap = JSON.parse(JSON.stringify(ledger));
    ledgerWrite = ledgerWrite.then(() => store.writeJsonAtomicAsync(ledgerFile, snap, { backup: false })).catch((e) => {
      console.warn(`[导入] 账本没写上：${(e && e.message) || e}`);
    });
    return ledgerWrite;
  };

  /* 本项目自己跑过的引擎会话 id（规则②）。按文件 mtime+体积缓存，只重读变过的 */
  const owb = { ids: new Set(), files: new Map(), running: null, at: 0 };
  const refreshOwb = () => {
    if (owb.running) return owb.running;
    owb.running = (async () => {
      const alive = new Set();
      for (const dir of sessionDirs) {
        let names = [];
        try { names = (await fsp.readdir(dir)).filter((n) => n.endsWith(".json")); } catch { continue; }
        await pool(names, 4, async (n) => {
          const f = path.join(dir, n);
          alive.add(f);
          let st;
          try { st = await fsp.stat(f); } catch { return; }
          const hit = owb.files.get(f);
          if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return;
          let text = "";
          try { text = await fsp.readFile(f, "utf8"); } catch { return; }
          const ids = new Set();
          for (const m of text.matchAll(ENGINE_KEY_RE)) for (const u of m[1].match(UUID_RE) || []) ids.add(u.toLowerCase());
          owb.files.set(f, { mtime: st.mtimeMs, size: st.size, ids: [...ids] });
        });
      }
      for (const f of [...owb.files.keys()]) if (!alive.has(f)) owb.files.delete(f);
      const all = new Set();
      for (const v of owb.files.values()) for (const u of v.ids) all.add(u);
      owb.ids = all;
      owb.at = Date.now();
    })().catch(() => {}).finally(() => { owb.running = null; });
    return owb.running;
  };

  /* 目录清单按目录 mtime 缓存：没动过的目录不再 readdir */
  const dirCache = new Map();
  async function readdirCached(dir) {
    let st;
    try { st = await fsp.stat(dir); } catch { dirCache.delete(dir); return []; }
    const hit = dirCache.get(dir);
    if (hit && hit.mtime === st.mtimeMs) return hit.list;
    let list = [];
    try { list = (await fsp.readdir(dir, { withFileTypes: true })).map((d) => ({ name: d.name, dir: d.isDirectory(), file: d.isFile() })); } catch {}
    dirCache.set(dir, { mtime: st.mtimeMs, list });
    return list;
  }

  /** 盘上有的全部候选（不含本项目自己建的目录），只 readdir */
  async function scan(source) {
    const root = rootOf(source);
    if (!root) return [];
    const out = [];
    if (source === "claude-code") {
      const roots = ownRoots();
      const dirs = (await readdirCached(root)).filter((d) => d.dir && !ownedDir(d.name, roots));
      await pool(dirs, 8, async (d) => {
        const sub = path.join(root, d.name);
        for (const f of await readdirCached(sub)) {
          if (f.file && CLAUDE_FILE_RE.test(f.name)) out.push({ id: f.name.slice(0, -6).toLowerCase(), file: path.join(sub, f.name), dirName: d.name });
        }
      });
    } else {
      const num = (n) => (d) => d.dir && new RegExp(`^\\d{${n}}$`).test(d.name);
      for (const y of (await readdirCached(root)).filter(num(4))) {
        for (const m of (await readdirCached(path.join(root, y.name))).filter(num(2))) {
          const mdir = path.join(root, y.name, m.name);
          await pool((await readdirCached(mdir)).filter(num(2)), 8, async (d) => {
            const ddir = path.join(mdir, d.name);
            for (const f of await readdirCached(ddir)) {
              const hit = f.file && ROLLOUT_RE.exec(f.name);
              if (hit) out.push({ id: hit[1].toLowerCase(), file: path.join(ddir, f.name) });
            }
          });
        }
      }
    }
    // 同一个 id 出现两次（复制过的文件）只留一条
    const seenIds = new Set();
    return out.filter((c) => !seenIds.has(c.id) && seenIds.add(c.id));
  }
  const notOurs = (source, c) => !owb.ids.has(c.id) && !alreadyImported(source, c.id);

  /* 读过开头的文件：标题、文件夹、是不是空会话。按 文件+体积+mtime 缓存 */
  const heads = new Map();
  async function headOf(source, c, st) {
    const hit = heads.get(c.file);
    if (hit && hit.size === st.size && hit.mtime === st.mtimeMs) return hit.info;
    let info;
    try {
      const r = source === "claude-code" ? await parseClaude(c.file, { dirName: c.dirName, head: true }) : await parseCodex(c.file, { head: true });
      info = { title: oneLine(r.title).slice(0, 80), cwd: r.cwd, empty: r.empty };
    } catch {
      info = { title: "", cwd: "", empty: false, bad: true };
    }
    heads.set(c.file, { size: st.size, mtime: st.mtimeMs, info });
    return info;
  }
  /** 读过开头、认出是空会话，而且之后没变过（rows 里的候选带着 stat） */
  const emptyNow = (c) => {
    const h = heads.get(c.file);
    return !!(h && h.info.empty && h.size === c.st.size && h.mtime === c.st.mtimeMs);
  };
  async function knownEmpty(c) {
    const hit = heads.get(c.file);
    if (!hit || !hit.info.empty) return false;
    try {
      const st = await fsp.stat(c.file);
      return st.size === hit.size && st.mtimeMs === hit.mtime;
    } catch { return true; }
  }

  /* 后台把小文件先读一遍开头：只有标题行的空会话早点认出来，下次的条数就准了 */
  let warming = null;
  function warm(source, list) {
    if (warming) return;
    warming = (async () => {
      let n = 0;
      for (const c of list) {
        if (n >= WARM_MAX) break;
        if (heads.has(c.file)) continue;
        let st;
        try { st = await fsp.stat(c.file); } catch { continue; }
        if (st.size > WARM_SIZE) continue;
        n++;
        await headOf(source, c, st);
        await tick();
      }
    })().catch(() => {}).finally(() => { warming = null; });
  }

  let countMemo = null;
  /** 每个来源还有几条没导的。只 readdir + stat；本项目那张 id 表在后台刷，等它最多 400ms */
  async function count() {
    if (countMemo && Date.now() - countMemo.at < COUNT_TTL) return countMemo.sources;
    await Promise.race([refreshOwb(), new Promise((r) => setTimeout(r, 400).unref())]);
    const sources = [];
    for (const source of SOURCE_IDS) {
      const all = (await scan(source)).filter((c) => notOurs(source, c));
      let n = 0;
      for (const c of all) if (!(await knownEmpty(c))) n++;
      sources.push({ source, name: SOURCES[source].name, count: n });
      warm(source, all);
    }
    countMemo = { at: Date.now(), sources };
    return sources;
  }

  /** 按时间倒序的候选（带 stat），列清单和导入共用 */
  async function candidates(source) {
    await refreshOwb();
    const all = (await scan(source)).filter((c) => notOurs(source, c));
    const rows = [];
    await pool(all, 16, async (c) => {
      try {
        const st = await fsp.stat(c.file);
        if (st.isFile()) rows.push({ ...c, st });
      } catch {}
    });
    rows.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
    return rows;
  }

  /** 一页清单：标题、时间、文件夹名。空会话跳过，一次最多读 limit*3 个文件的开头 */
  async function list(source, { offset = 0, limit = 30 } = {}) {
    if (!SOURCES[source]) throw Object.assign(new Error("不认识这个来源"), { status: 400 });
    const lim = Math.max(1, Math.min(100, Number(limit) || 30));
    const rows = await candidates(source);
    const items = [];
    let i = Math.max(0, Number(offset) || 0);
    let read = 0;
    while (i < rows.length && items.length < lim && read < lim * 3) {
      const c = rows[i++];
      const cached = heads.get(c.file);
      if (!cached || cached.size !== c.st.size || cached.mtime !== c.st.mtimeMs) read++;
      const h = await headOf(source, c, c.st);
      if (h.empty) continue;
      items.push({ id: c.id, title: h.title || `本机 ${SOURCES[source].name} 会话`, at: c.st.mtimeMs, folder: h.cwd ? path.basename(h.cwd) : "" });
    }
    const empties = rows.filter(emptyNow).length;
    return { source, name: SOURCES[source].name, total: rows.length - empties, next: i < rows.length ? i : null, items };
  }

  /** 导一条：读整份、拼成会话、落盘、记账。空会话返回 null */
  async function importOne(source, c, owner) {
    const r = source === "claude-code" ? await parseClaude(c.file, { dirName: c.dirName }) : await parseCodex(c.file);
    const rec = toSession({ source, id: c.id, file: c.file, cwd: r.cwd, title: r.title, turns: r.turns, mtimeMs: c.st.mtimeMs, owner });
    if (!rec) return null;
    let sid;
    do sid = "s_" + Date.now() + "_" + Math.floor(Math.random() * 1e6); while (sessionExists(sid));
    await store.writeJsonAtomicAsync(sessionFile(sid), rec, { backup: false });
    await remember(source, c.id, sid);
    return sid;
  }

  /* 一次只跑一单；进度给前端轮询 */
  let job = null;
  const view = () => (job ? { id: job.id, source: job.source, total: job.total, done: job.done, skipped: job.skipped, failed: job.failed, state: job.state, first: job.first || "" } : null);
  /**
   * @param ids  要导的原 id（只认刚找到的候选里有的）；all=true 就是全部
   * @returns {{busy?:true, job:object}}
   */
  async function start(source, { ids, all = false, owner = "" } = {}) {
    if (!SOURCES[source]) throw Object.assign(new Error("不认识这个来源"), { status: 400 });
    if (job && job.state === "running") return { busy: true, job: view() };
    job = { id: Date.now().toString(36), source, total: 0, done: 0, skipped: 0, failed: 0, state: "running", first: "" };
    const mine = job;
    let picked;
    try {
      const rows = await candidates(source);
      // 全部：已经认出来的空会话不算进去（没读过开头的照样排进来，导的时候是空的就跳过）
      if (all) picked = rows.filter((c) => !emptyNow(c));
      else {
        const want = new Set((Array.isArray(ids) ? ids : []).map((x) => String(x).toLowerCase()));
        picked = rows.filter((c) => want.has(c.id));
      }
    } catch (e) {
      mine.state = "done";
      throw e;
    }
    if (!picked.length) {
      job = null;
      throw Object.assign(new Error(all ? "没有能导入的会话了" : "选的这几条找不到了，刷新一下再选"), { status: 400 });
    }
    mine.total = picked.length;
    (async () => {
      for (const c of picked) {
        if (alreadyImported(source, c.id)) { mine.skipped++; continue; }
        try {
          const sid = await importOne(source, c, owner);
          if (sid) { mine.done++; if (!mine.first) mine.first = sid; }
          else mine.skipped++;
        } catch (e) {
          mine.failed++;
          console.warn(`[导入] 有一条没导进来：${(e && e.message) || e}`);
        }
        await tick(); // 几百条也不霸着事件循环
      }
    })().finally(() => {
      mine.state = "done";
      countMemo = null;
    });
    return { job: view() };
  }

  return { count, list, start, job: view, alreadyImported, _internals: { scan, refreshOwb, owb, heads, ledger: () => book() } };
}

module.exports = {
  createSessionImporter, continuePlan, parseClaude, parseCodex, encodeCwd, claudeRoot, codexRoot, SOURCES,
  _internals: { eachLine, toSession, cleanClaudeText, codexTool, claudeTool, codexOutput, ownRoots, ownedDir, rolloutOk, ENGINE_KEY_RE },
};
