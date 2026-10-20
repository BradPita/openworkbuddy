// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 OpenWorkBuddy Contributors · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 导入本机终端里的 Claude Code / Codex 会话（src/domains/import/session-import.js + src/server/routes/session-import.js）。
 *
 *   ① 只读假目录：两个来源的目录都用环境变量指到临时目录，绝不碰真的 ~/.claude、~/.codex
 *   ② 谁能导：只有这台机器的主人；成员、没登录的四个接口全 403，回包里连条数都没有
 *   ③ 数、列：本项目自己建的目录、本项目自己跑过的引擎会话、只有标题的空会话都不算
 *   ④ 解析容错：坏行跳过、不认识的类型不管；系统提醒、子任务、元信息不进会话；
 *      同一条消息写两遍只算一次；工具调用压成一行人话；几 MB 的工具输出只留一小段预览
 *   ⑤ 去重：同一条导两次不出两份；导进来的删了才能再导
 *   ⑥ 几百条在后台导：接口立刻回、有进度、事件循环不被霸着；正在导时再点回「忙」
 *   ⑦ 接着聊：主人 + 原文件夹还在 + 同一个引擎 → 接原来那根线（Claude Code 分出新的、Codex 先复制一份）；
 *      别的情况把前面的对话当背景；换了跑法才说一声
 *   ⑧ 引擎那层真按这个跑：原文件夹、--resume + --fork-session、分不出新会话就不续、rollout 复制进隔离运行窝
 *   ⑨ 接线：server.js 用 isPlatformOwner 挂路由、/api/chat 走 continuePlan；/api/import/ 进了平台读写两张表
 *   ★反向对照★ 去掉主人检查、去掉去重，上面对应的断言必须红
 *
 * 原文件导入前后逐个比哈希：一个字节都不许变。
 *   node test/session-import.js
 */
const { mod } = require("./lib/mod");
const HOME = require("./lib/own-home")("session-import");

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const Module = require("module");

// 两个来源的目录一律指到临时目录；连兜底的 CLAUDE_CONFIG_DIR / CODEX_HOME 也换掉，漏设一个也读不到真的
const FAKE = fs.mkdtempSync(path.join(os.tmpdir(), "owb-session-import-src-"));
const CLAUDE = path.join(FAKE, "claude", "projects");
const CODEX = path.join(FAKE, "codex", "sessions");
process.env.OPENWORKBUDDY_IMPORT_CLAUDE_DIR = CLAUDE;
process.env.OPENWORKBUDDY_IMPORT_CODEX_DIR = CODEX;
process.env.CLAUDE_CONFIG_DIR = path.join(FAKE, "claude");
process.env.CODEX_HOME = path.join(FAKE, "codex");

const express = require("express");
const { dataPath } = require(mod("paths"));
const si = require(mod("session-import"));
const { createSessionImportRouter } = require(mod("routes/session-import"));
const { src } = require("./lib/src");

let pass = 0, fail = 0, finished = false;
process.on("exit", (code) => {
  if (!finished && code === 0) {
    console.log(`\n✗ 这套测试没跑完就退了（跑到第 ${pass + fail} 条）`);
    process.exitCode = 1;
  }
  if ((Number(process.exitCode) || code || 0) === 0) { try { fs.rmSync(FAKE, { recursive: true, force: true }); } catch {} }
  else console.log("留着现场（假的本机会话）：" + FAKE);
});
function ok(cond, name, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra !== undefined ? "  ← " + JSON.stringify(extra).slice(0, 400) : ""}`); }
}
function eq(got, want, name) { ok(Object.is(got, want), name, Object.is(got, want) ? undefined : { got, want }); }
async function section(title, fn) {
  console.log("\n" + title);
  try { await fn(); } catch (e) { fail++; console.log(`  ✗ 这一段直接炸了：${(e && e.stack || e).toString().split("\n").slice(0, 4).join(" | ")}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const L = (o) => JSON.stringify(o);
const at = (min) => new Date(Date.UTC(2026, 9, 1, 8, min)).toISOString();
const uuid = () => crypto.randomUUID();
function put(file, lines) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return file;
}
/** FAKE 底下的一个子目录：FAKE 本身已经是独一份的临时目录，收尾时整个删 */
const sub = (name) => { const d = path.join(FAKE, name); fs.mkdirSync(d, { recursive: true }); return d; };
const touch = (file, minutesAgo) => { const t = new Date(Date.now() - minutesAgo * 60000); fs.utimesSync(file, t, t); };

/* ---------- 假的本机会话 ---------- */

const PROJ = path.join(FAKE, "proj-a");
fs.mkdirSync(PROJ, { recursive: true });
const GONE = path.join(FAKE, "gone");
const SESS = dataPath("data", "sessions");
const IMS = dataPath("data", "im-sessions");
const [A, B, C, D, E, F1, F2, G, H, FORKED] = Array.from({ length: 10 }, uuid);
const projDir = path.join(CLAUDE, si.encodeCwd(PROJ));
const BIG_RESULT = "log line with some output\n".repeat(120000); // 3MB 上下
const BIG_OUTPUT = "y".repeat(2 * 1024 * 1024);

const FILES = {};
FILES.A = put(path.join(projDir, A + ".jsonl"), [
  L({ type: "summary", summary: "修登录页的跳转", leafUuid: "x" }),
  "{这一行是坏的",
  L({ type: "file-history-snapshot", messageId: "m0", snapshot: {} }),
  L({ type: "user", cwd: PROJ, sessionId: A, timestamp: at(1), message: { role: "user", content: [{ type: "text", text: "<system-reminder>这段提醒不算话</system-reminder>帮我看看登录页为什么不跳转" }] } }),
  L({ type: "assistant", cwd: PROJ, timestamp: at(2), message: { id: "msg1", role: "assistant", model: "m", content: [{ type: "text", text: "我先搜一下跳转的代码。" }, { type: "tool_use", id: "tu1", name: "Bash", input: { command: "grep -rn redirect src/", description: "搜跳转" } }] } }),
  // 同一条消息整条又写了一遍
  L({ type: "assistant", cwd: PROJ, timestamp: at(2), message: { id: "msg1", role: "assistant", model: "m", content: [{ type: "text", text: "我先搜一下跳转的代码。" }, { type: "tool_use", id: "tu1", name: "Bash", input: { command: "grep -rn redirect src/" } }] } }),
  L({ type: "user", cwd: PROJ, timestamp: at(3), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: BIG_RESULT, is_error: false }] } }),
  L({ type: "assistant", cwd: PROJ, timestamp: at(4), message: { id: "msg2", role: "assistant", model: "m", content: [{ type: "text", text: "改好了，跳转回首页。" }] } }),
  L({ type: "assistant", isSidechain: true, cwd: PROJ, timestamp: at(5), message: { id: "msg3", role: "assistant", content: [{ type: "text", text: "子任务里的话不该进来" }] } }),
  L({ type: "user", isMeta: true, cwd: PROJ, timestamp: at(6), message: { role: "user", content: "元信息不该进来" } }),
  L({ type: "something-new", cwd: PROJ, payload: { x: 1 } }),
]);
FILES.B = put(path.join(projDir, B + ".jsonl"), [
  L({ type: "user", cwd: PROJ, timestamp: at(10), message: { role: "user", content: "把 README 翻成英文" } }),
  L({ type: "assistant", cwd: PROJ, timestamp: at(11), message: { id: "b1", role: "assistant", content: [{ type: "text", text: "翻好了。" }] } }),
]);
// 只有一行标题：空会话，不算
FILES.C = put(path.join(projDir, C + ".jsonl"), [L({ type: "summary", summary: "只有标题" })]);
// 规则①：落在本项目自己建的目录下、引擎自测的临时目录下
FILES.D = put(path.join(CLAUDE, si.encodeCwd(path.resolve(dataPath("workspace"))) + "-sub", D + ".jsonl"), [
  L({ type: "user", cwd: "/x", timestamp: at(12), message: { role: "user", content: "本项目工作区里跑的" } }),
]);
FILES.E = put(path.join(CLAUDE, "-private-tmp-owb-engine-test-abc", E + ".jsonl"), [
  L({ type: "user", cwd: "/x", timestamp: at(13), message: { role: "user", content: "引擎自测跑的" } }),
]);
// 规则②：引擎会话 id 记在本项目会话里（网页会话记成表，IM 会话记成一串）
FILES.F1 = put(path.join(projDir, F1 + ".jsonl"), [L({ type: "user", cwd: PROJ, timestamp: at(14), message: { role: "user", content: "本项目拉起来的那一趟" } })]);
FILES.F2 = put(path.join(projDir, F2 + ".jsonl"), [L({ type: "user", cwd: PROJ, timestamp: at(15), message: { role: "user", content: "IM 那边拉起来的那一趟" } })]);
fs.mkdirSync(SESS, { recursive: true });
fs.mkdirSync(IMS, { recursive: true });
fs.writeFileSync(path.join(SESS, "s_owb_1.json"), JSON.stringify({ title: "本项目自己的", history: [{ role: "user", content: "随便提一句 " + A }], engine_sessions: { "claude-code": F1.toUpperCase() } }));
fs.writeFileSync(path.join(IMS, "wx_1.json"), JSON.stringify({ engine_session: F2 }));

FILES.G = put(path.join(CODEX, "2026", "10", "02", `rollout-2026-10-02T09-00-00-${G}.jsonl`), [
  L({ timestamp: at(20), type: "session_meta", payload: { id: G, timestamp: at(20), cwd: PROJ, originator: "cli", cli_version: "0.1" } }),
  L({ timestamp: at(20), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `<environment_context>\n  <cwd>${PROJ}</cwd>\n</environment_context>` }] } }),
  L({ timestamp: at(21), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "列一下这个目录" }] } }),
  L({ timestamp: at(21), type: "event_msg", payload: { type: "user_message", message: "列一下这个目录", images: [] } }),
  L({ timestamp: at(21), type: "turn_context", payload: { cwd: PROJ, model: "m" } }),
  L({ timestamp: at(22), type: "response_item", payload: { type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["bash", "-lc", "ls -la"] }), call_id: "c1" } }),
  L({ timestamp: at(22), type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: JSON.stringify({ output: BIG_OUTPUT, metadata: { exit_code: 1, duration_seconds: 0.1 } }) } }),
  L({ timestamp: at(23), type: "response_item", payload: { type: "custom_tool_call", name: "apply_patch", input: "*** Begin Patch\n*** Update File: run.sh\n@@\n-a\n+b\n*** End Patch", call_id: "c2", status: "completed" } }),
  L({ timestamp: at(23), type: "response_item", payload: { type: "custom_tool_call_output", call_id: "c2", output: "Success" } }),
  L({ timestamp: at(24), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "目录列好了，顺手改了 run.sh。" }] } }),
  L({ timestamp: at(24), type: "event_msg", payload: { type: "agent_message", message: "目录列好了，顺手改了 run.sh。" } }),
  "坏行{{{",
  L({ timestamp: at(25), type: "event_msg", payload: { type: "token_count", info: null } }),
]);
// 老格式：第一行没有 type，有一行 record_type，消息是裸的
FILES.H = put(path.join(CODEX, "2025", "04", "20", `rollout-2025-04-20T10-00-00-${H}.jsonl`), [
  L({ id: H, timestamp: "2025-04-20T10:00:00.000Z", instructions: null }),
  L({ record_type: "state" }),
  L({ type: "message", role: "user", content: [{ type: "input_text", text: `<environment_context>\n<cwd>${PROJ}</cwd>\n</environment_context>` }] }),
  L({ type: "message", role: "user", content: [{ type: "input_text", text: "老格式里的一个问题" }] }),
  L({ type: "message", role: "assistant", content: [{ type: "output_text", text: "老格式里的回答" }] }),
]);
touch(FILES.A, 50); touch(FILES.B, 40); touch(FILES.G, 30); touch(FILES.H, 60);
const HASH_BEFORE = Object.fromEntries(Object.entries(FILES).map(([k, f]) => [k, sha(f)]));

/* ---------- 小工具 ---------- */

const USERS = {
  boss: { username: "boss", role: "owner" },
  alice: { username: "alice", role: "member" },
  dave: { username: "dave", role: "admin", org: "acme" },
};
const isOwner = (req) => !!(req.user && req.user.username === "boss");
function serve(router) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = USERS[req.headers["x-u"]] || null; next(); });
  app.use(router);
  return new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
}
function call(server, method, url, user, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { ...(user ? { "x-u": user } : {}), ...(data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}) };
    const req = http.request({ host: "127.0.0.1", port: server.address().port, method, path: url, headers }, (res) => {
      let s = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (s += c));
      res.on("end", () => { let j = null; try { j = JSON.parse(s); } catch {} resolve({ status: res.statusCode, body: j }); });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}
async function waitJob(server, user = "boss", ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    const r = await call(server, "GET", "/api/import/local/job", user);
    if (r.body && r.body.job && r.body.job.state === "done") return r.body.job;
    if (Date.now() > end) return r.body && r.body.job;
    await sleep(20);
  }
}
/** 一个目录里导进来的会话（按来源 id 认） */
function importedIn(dir) {
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith(".json")); } catch {}
  const out = [];
  for (const n of names) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, n), "utf8"));
      if (j && j.imported) out.push({ sid: n.slice(0, -5), file: path.join(dir, n), size: fs.statSync(path.join(dir, n)).size, rec: j });
    } catch {}
  }
  return out;
}
/** 拿源码改一处再编出一份新模块（反向对照用）：改不着就当场炸，免得「没改成」也算红 */
function mutant(file, from, to) {
  const text = fs.readFileSync(file, "utf8");
  const mut = text.replace(from, to);
  if (mut === text) throw new Error("反向对照的靶子不在源码里了：" + String(from).slice(0, 80));
  const m = new Module(file, null);
  m.filename = file;
  m.paths = Module._nodeModulePaths(path.dirname(file));
  m._compile(mut, file);
  return m.exports;
}
const sessFile = (dir) => (id) => path.join(dir, String(id).replace(/[^\w-]/g, "_") + ".json");
const GATE_LINE = `    if (!isOwner(req)) return res.status(403).json({ error: "只有这台机器的主人能导入本机会话", platform_only: true });\n`;
const DEDUP_LINE = "return !!(e && e.sid && sessionExists(e.sid));";

(async () => {
  const importer = si.createSessionImporter({ sessionFile: sessFile(SESS) });
  const server = await serve(createSessionImportRouter({ enabled: true, isOwner, importer }));
  const servers = [server];
  try {
    await section("默认关闭：所有导入接口均不可用，不触碰扫描器", async () => {
      let calls = 0;
      const disabled = await serve(createSessionImportRouter({ isOwner, importer: new Proxy({}, { get() { calls++; throw new Error("不应扫描"); } }) }));
      servers.push(disabled);
      for (const user of ["boss", "alice", ""]) {
        for (const [method, url] of [["GET", "/api/import/local"], ["GET", "/api/import/local/list?source=codex"], ["POST", "/api/import/local"], ["GET", "/api/import/local/job"]]) {
          const r = await call(disabled, method, url, user, method === "POST" ? { source: "codex", all: true } : null);
          ok(r.status === 404 && r.body.disabled === true, `${user || "匿名"} ${method} ${url}：关闭`);
          ok(!("sources" in r.body) && !("items" in r.body) && !("job" in r.body), "不返回会话数据");
        }
      }
      eq(calls, 0, "关闭时连扫描器属性都不读取");
    });

    await section("① 只读假目录", async () => {
      ok(si.claudeRoot() === CLAUDE && si.codexRoot() === CODEX, "两个来源都指在临时目录里", { claude: si.claudeRoot(), codex: si.codexRoot() });
      const keep = process.env.OPENWORKBUDDY_IMPORT_CODEX_DIR;
      const keepHome = process.env.CODEX_HOME;
      try {
        delete process.env.OPENWORKBUDDY_IMPORT_CODEX_DIR;
        process.env.CODEX_HOME = dataPath("data", "runtime", "codex");
        eq(si.codexRoot(), "", "CODEX_HOME 恰好是本项目自己的隔离运行窝：那里全是本项目跑的，不当本机会话");
      } finally {
        process.env.OPENWORKBUDDY_IMPORT_CODEX_DIR = keep;
        process.env.CODEX_HOME = keepHome;
      }
      eq(si.encodeCwd("/Users/x/my proj.v2"), "-Users-x-my-proj-v2", "文件夹编码：字母数字以外换成 -");
    });

    await section("② 谁能导：成员、没登录的一律 403，连条数都没有", async () => {
      for (const u of ["alice", "dave", ""]) {
        const rs = [
          await call(server, "GET", "/api/import/local", u),
          await call(server, "GET", "/api/import/local/list?source=claude-code", u),
          await call(server, "POST", "/api/import/local", u, { source: "claude-code", all: true }),
          await call(server, "GET", "/api/import/local/job", u),
        ];
        ok(rs.every((r) => r.status === 403), `${u || "没登录"}：四个接口都是 403`, rs.map((r) => r.status));
        ok(rs.every((r) => r.body && r.body.platform_only === true && !("sources" in r.body) && !("items" in r.body) && !("total" in r.body) && !("job" in r.body)),
          `${u || "没登录"}：回包里没有条数、清单、进度`, rs.map((r) => r.body));
      }
      await sleep(50);
      eq(importedIn(SESS).length, 0, "成员那一下 POST 没导进来任何一条");
    });

    await section("③ 数、列：本项目自己的、空会话都不算", async () => {
      const lc = await call(server, "GET", "/api/import/local/list?source=claude-code", "boss");
      eq(lc.status, 200, "主人能列 Claude Code 的清单");
      const ids = (lc.body.items || []).map((x) => x.id);
      ok(ids.length === 2 && ids[0] === B && ids[1] === A, "只列出 A、B，新的在前（空会话 C、本项目目录下的 D/E、本项目跑过的 F1/F2 都不列）", ids.map((x) => [A, B, C, D, E, F1, F2].indexOf(x)));
      eq(lc.body.total, 2, "总数 2");
      const a = (lc.body.items || []).find((x) => x.id === A) || {};
      const b = (lc.body.items || []).find((x) => x.id === B) || {};
      ok(a.title === "修登录页的跳转" && a.folder === "proj-a", "有标题行的用标题行，文件夹给名字", a);
      eq(b.title, "把 README 翻成英文", "没有标题行的用第一句用户话");
      const lx = await call(server, "GET", "/api/import/local/list?source=codex", "boss");
      const xi = (lx.body.items || []);
      ok(lx.status === 200 && xi.length === 2 && xi[0].id === G && xi[1].id === H, "Codex 新旧两种格式都列出来", xi.map((x) => x.id === G ? "G" : x.id === H ? "H" : "?"));
      ok((xi[0] || {}).title === "列一下这个目录" && (xi[1] || {}).title === "老格式里的一个问题", "Codex 的标题是用户原话，不是塞给模型的环境说明", xi.map((x) => x.title));
      ok(xi.every((x) => x.folder === "proj-a"), "Codex 的文件夹从会话头、老格式从环境说明里认出来", xi.map((x) => x.folder));
      const bad = await call(server, "GET", "/api/import/local/list?source=nope", "boss");
      ok(bad.status === 400 && bad.body.error === "不认识这个来源", "不认识的来源 400", bad);
      const t0 = Date.now();
      const c = await call(server, "GET", "/api/import/local", "boss");
      const ms = Date.now() - t0;
      const n = Object.fromEntries((c.body.sources || []).map((s) => [s.source, s.count]));
      ok(c.status === 200 && n["claude-code"] === 2 && n.codex === 2, "条数：Claude Code 2、Codex 2", c.body);
      console.log(`    （数条数 ${ms}ms）`);
    });

    await section("④ 导进来长什么样：容错、压成人话、大输出只留预览", async () => {
      const r = await call(server, "POST", "/api/import/local", "boss", { source: "claude-code", ids: [A.toUpperCase()] });
      ok(r.status === 202 && r.body.job && r.body.job.total === 1 && r.body.job.state === "running", "202 立刻回进度单（id 大小写不论）", r.body);
      const job = await waitJob(server);
      ok(job && job.done === 1 && job.failed === 0 && /^s_/.test(job.first), "导完：1 条，first 是新会话 id", job);
      const got = importedIn(SESS).filter((x) => x.rec.imported.id === A);
      eq(got.length, 1, "盘上多了一条，来源 id 记着");
      const s = (got[0] || {}).rec || {};
      ok(got[0] && got[0].size < 200 * 1024, "3MB 的工具输出没塞进会话（文件很小）", got[0] && got[0].size);
      ok(s.title === "修登录页的跳转" && s.lane === "cli" && s.user === "boss", "标题、放进「工程」那栏、记着是谁导的", { title: s.title, lane: s.lane, user: s.user });
      ok(s.imported && s.imported.source === "claude-code" && s.imported.cwd === PROJ && s.imported.file === FILES.A && s.imported.hist === (s.history || []).length,
        "记着来源、原文件夹、原文件、导进来时的历史长度", s.imported);
      const flat = JSON.stringify(s);
      ok(!/system-reminder|这段提醒不算话|子任务里的话|元信息不该进来/.test(flat), "系统提醒、子任务、元信息都没进来");
      const h = s.history || [];
      ok(h[0] && h[0].role === "user" && h[0].content === "帮我看看登录页为什么不跳转", "历史第一句是用户原话（提醒洗掉了）", h[0]);
      const asst = h.find((x) => x.role === "assistant") || {};
      ok(/我先搜一下跳转的代码。/.test(asst.text) && /改好了，跳转回首页。/.test(asst.text) && /〔用过的工具〕命令 grep -rn redirect src\//.test(asst.text),
        "助理那段：两句话 + 一行「用过的工具」", asst.text);
      eq((asst.text.match(/我先搜一下跳转的代码。/g) || []).length, 1, "同一条消息写了两遍只算一次");
      const evs = (s.transcript || []).flatMap((t) => t.events || []);
      const use = evs.filter((e) => e.type === "tool_use");
      const res = evs.find((e) => e.type === "tool_result") || {};
      ok(use.length === 1 && use[0].name === "run_shell" && use[0].title === "命令 grep -rn redirect src/", "工具调用压成一行人话（一张卡）", use);
      ok(res.preview && res.preview.length <= 300 && res.cut === true && res.isError === false, "工具输出只留 300 字预览、标了截断", { len: (res.preview || "").length, cut: res.cut });
      ok(evs.some((e) => e.notice && e.text === "从本机 Claude Code 导入 · 文件夹 proj-a · 可以接着聊"), "末尾说一声从哪儿导的、可以接着聊");

      const x = await call(server, "POST", "/api/import/local", "boss", { source: "codex", all: true });
      eq(x.status, 202, "Codex 全部导入 202");
      const xj = await waitJob(server);
      ok(xj && xj.done === 2 && xj.failed === 0, "Codex 两条都导进来", xj);
      const g = (importedIn(SESS).find((y) => y.rec.imported.id === G) || {}).rec || {};
      const gh = g.history || [];
      ok(gh.filter((y) => y.role === "user").length === 1 && gh[0].content === "列一下这个目录", "新格式两边都记的用户话只算一次，环境说明不算", gh.map((y) => y.role));
      ok(gh[1] && (gh[1].text.match(/目录列好了/g) || []).length === 1, "助理话也只算一次", gh[1]);
      const gev = (g.transcript || []).flatMap((t) => t.events || []);
      const gtools = gev.filter((e) => e.type === "tool_use").map((e) => e.title);
      ok(gtools[0] === "命令 ls -la" && gtools[1] === "改 run.sh", "shell 和 apply_patch 都压成一行人话", gtools);
      const gres = gev.find((e) => e.type === "tool_result" && e.name === "run_shell") || {};
      ok(gres.isError === true && gres.preview.length <= 300 && gres.cut === true, "退出码不是 0 记成出错；2MB 输出只留预览", { isError: gres.isError, len: (gres.preview || "").length });
      ok(g.imported && g.imported.cwd === PROJ && g.imported.file === FILES.G, "Codex 记着原文件夹、原文件");
      const hh = (importedIn(SESS).find((y) => y.rec.imported.id === H) || {}).rec || {};
      ok(hh.history && hh.history[0].content === "老格式里的一个问题" && /老格式里的回答/.test(hh.history[1].text), "老格式也读得出来", hh.history);
      // 超长的一行（跨了好几块读）整行跳过，后面的照读
      const long = put(path.join(FAKE, "long.jsonl"), ["first", "z".repeat(600 * 1024), "after"]);
      const seen = [];
      const done = await si._internals.eachLine(long, (line) => { seen.push(line.length > 20 ? "长行" : line); }, { maxLine: 300 * 1024 });
      ok(done.complete && seen.join(",") === "first,after", "超长的一行整行跳过，前后两行照读", seen);
    });

    await section("⑤ 去重：同一条导两次不出两份", async () => {
      const again = await call(server, "POST", "/api/import/local", "boss", { source: "claude-code", ids: [A] });
      ok(again.status === 400 && /找不到了/.test(again.body.error), "再导一次 A：已经导过，不在候选里了（400）", again);
      await sleep(30);
      eq(importedIn(SESS).filter((x) => x.rec.imported.id === A).length, 1, "盘上还是只有一份 A");
      const c = await call(server, "GET", "/api/import/local", "boss");
      const n = Object.fromEntries((c.body.sources || []).map((s) => [s.source, s.count]));
      ok(n["claude-code"] === 1 && n.codex === 0, "条数跟着变：Claude Code 只剩 B，Codex 0", n);
      const rest = await call(server, "POST", "/api/import/local", "boss", { source: "claude-code", all: true });
      eq(rest.status, 202, "全部导入：只剩 B");
      const rj = await waitJob(server);
      ok(rj && rj.done === 1 && rj.total === 1, "这一单只导了 B", rj);
      const none = await call(server, "POST", "/api/import/local", "boss", { source: "codex", all: true });
      ok(none.status === 400 && none.body.error === "没有能导入的会话了", "都导过了再点全部：没有能导入的", none.body);
      // 导进来的删了：账上那条不作数，可以再导
      const a = importedIn(SESS).find((x) => x.rec.imported.id === A);
      fs.rmSync(a.file);
      const back = await call(server, "GET", "/api/import/local/list?source=claude-code", "boss");
      ok((back.body.items || []).some((x) => x.id === A), "导进来的那条删了，A 又能导了", back.body.total);
      for (const [k, f] of Object.entries(FILES)) if (sha(f) !== HASH_BEFORE[k]) ok(false, `原文件 ${k} 被改了`);
      ok(Object.entries(FILES).every(([k, f]) => sha(f) === HASH_BEFORE[k]), `列、数、导了几遍，${Object.keys(FILES).length} 个原文件一个字节都没变`);
    });

    await section("⑥ 几百条在后台导：立刻回、有进度、不霸着事件循环", async () => {
      const BULK = sub("bulk");
      const bulkDir = path.join(BULK, "projects", si.encodeCwd(PROJ));
      const N = 150;
      for (let i = 0; i < N; i++) {
        put(path.join(bulkDir, uuid() + ".jsonl"), [
          L({ type: "user", cwd: PROJ, timestamp: at(i % 60), message: { role: "user", content: `第 ${i} 条会话` } }),
          L({ type: "assistant", cwd: PROJ, timestamp: at(i % 60), message: { id: "m" + i, role: "assistant", content: [{ type: "text", text: "好的" }] } }),
        ]);
      }
      const out = path.join(BULK, "sessions");
      const keep = process.env.OPENWORKBUDDY_IMPORT_CLAUDE_DIR;
      process.env.OPENWORKBUDDY_IMPORT_CLAUDE_DIR = path.join(BULK, "projects");
      let iv = null;
      try {
        const imp = si.createSessionImporter({ sessionFile: sessFile(out), sessionDirs: [out], ledgerFile: path.join(BULK, "ledger.json") });
        let last = Date.now(), maxGap = 0;
        iv = setInterval(() => { const t = Date.now(); maxGap = Math.max(maxGap, t - last); last = t; }, 5);
        const t0 = Date.now();
        const r = await imp.start("claude-code", { all: true, owner: "boss" });
        const back = Date.now() - t0;
        ok(r.job && r.job.state === "running" && r.job.total === N && r.job.done === 0, "开始导就回：还在跑、一条都没导完", r.job);
        const busy = await imp.start("claude-code", { all: true });
        ok(busy.busy === true && busy.job && busy.job.id === r.job.id, "正在导时再点：回「忙」，不开第二单");
        let mid = 0, prev = 0, mono = true;
        const end = Date.now() + 60000;
        while (imp.job().state === "running" && Date.now() < end) {
          const j = imp.job();
          if (j.done < prev) mono = false;
          prev = j.done;
          if (j.done > 0 && j.done < j.total) mid++;
          await sleep(10);
        }
        const all = Date.now() - t0;
        const j = imp.job();
        ok(j.state === "done" && j.done === N && j.failed === 0, `${N} 条都导进来`, j);
        ok(mid > 0 && mono, "中途看得见进度、只往前走", { mid, mono });
        ok(maxGap < 400, "导的时候事件循环一直在转（最长卡顿 < 400ms）", maxGap);
        eq(importedIn(out).length, N, "盘上正好这么多条");
        console.log(`    （${N} 条：接口 ${back}ms 回，全部导完 ${all}ms，最长卡顿 ${maxGap}ms）`);
      } finally {
        if (iv) clearInterval(iv);
        process.env.OPENWORKBUDDY_IMPORT_CLAUDE_DIR = keep;
      }
    });

    await section("⑦ 接着聊：用哪根线、在哪个文件夹", async () => {
      const plain = si.continuePlan({ history: [] }, { engine: "claude-code", owner: true, engineSession: "abc" });
      ok(plain.engineSession === "abc" && plain.engineImport === null && plain.notice === "", "没导入过的会话原样放行", plain);
      const mk = (imp, history) => ({ imported: { at: 1, ...imp }, history: history || [{ role: "user", content: "旧" }, { role: "assistant", text: "旧答" }, { role: "user", content: "接着来" }] });
      const cl = () => mk({ source: "claude-code", id: A, cwd: PROJ, file: FILES.A, hist: 2 });

      const s1 = cl();
      const b1 = si.continuePlan(s1, { engine: "builtin", owner: true, engineSession: null });
      ok(b1.engineSession === null && b1.engineImport === null && /内置引擎/.test(b1.notice), "内置引擎：当背景、在任务文件夹里", b1);
      eq(si.continuePlan(s1, { engine: "builtin", owner: true }).notice, "", "跑法没变不再说第二遍");

      const g1 = si.continuePlan(cl(), { engine: "claude-code", owner: false, engineSession: null });
      ok(g1.engineSession === null && g1.engineImport === null && /只有导入它的人能用/.test(g1.notice), "不是主人：原文件夹不给用、不接原来的线", g1);

      const n1 = si.continuePlan(mk({ source: "claude-code", id: A, cwd: GONE, hist: 2 }), { engine: "claude-code", owner: true, engineSession: null });
      ok(n1.engineSession === null && n1.engineImport === null && /找不到了/.test(n1.notice), "原文件夹没了：在任务文件夹里接着聊", n1);

      const s2 = cl();
      const r1 = si.continuePlan(s2, { engine: "claude-code", owner: true, engineSession: null });
      ok(r1.engineSession === A && r1.engineImport && r1.engineImport.cwd === PROJ && r1.engineImport.fork === true && /接着原来那条 Claude Code 会话/.test(r1.notice),
        "主人 + 文件夹在 + 同一个引擎：接原来那根线、分出新的", r1);
      ok(s2.imported.mode === "resume", "跑法记在会话里（随会话存盘）");
      // 跑完一轮，新分出来的那根 id 记进会话；下一轮续它自己的，不再分
      s2.history.push({ role: "assistant", text: "好" }, { role: "user", content: "再改一下" });
      const r2 = si.continuePlan(s2, { engine: "claude-code", owner: true, engineSession: FORKED });
      ok(r2.engineSession === FORKED && r2.engineImport && r2.engineImport.cwd === PROJ && !r2.engineImport.fork && r2.notice === "", "第二轮：续分出来的那根，还在原文件夹，不再说", r2);

      const x1 = si.continuePlan(cl(), { engine: "codex", owner: true, engineSession: null });
      ok(x1.engineSession === null && x1.engineImport && x1.engineImport.cwd === PROJ && /前面的对话当背景带给 Codex/.test(x1.notice), "换了引擎：当背景，还在原文件夹", x1);

      const extra = cl();
      extra.history.splice(2, 0, { role: "assistant", text: "中途别的引擎答过" });
      const e1 = si.continuePlan(extra, { engine: "claude-code", owner: true, engineSession: null });
      ok(e1.engineSession === null && e1.engineImport && e1.engineImport.cwd === PROJ, "导进来之后中途有别的回答：不接原来的线（接了会漏掉中间那段）", e1);

      const cx = si.continuePlan(mk({ source: "codex", id: G, cwd: PROJ, file: FILES.G, hist: 2 }), { engine: "codex", owner: true, engineSession: null });
      ok(cx.engineSession === G && cx.engineImport && cx.engineImport.rollout === FILES.G && cx.engineImport.cwd === PROJ, "Codex：接原来那根线，带上原文件好复制一份", cx);
      const outside = put(path.join(FAKE, "elsewhere", path.basename(FILES.G)), ["{}"]);
      const co = si.continuePlan(mk({ source: "codex", id: G, cwd: PROJ, file: outside, hist: 2 }), { engine: "codex", owner: true, engineSession: null });
      ok(co.engineSession === null && co.engineImport && !co.engineImport.rollout, "记下的文件不在 Codex 会话目录里：不拿去复制，当背景", co);
    });

    await section("⑧ 引擎那层真按这个跑", async () => {
      const engines = require(mod("engines"));
      const { createAgentRuntime } = require(mod("agent"));
      const { McpManager } = require(mod("mcp"));
      const runStub = async (id, extra, { history, engineSession, engineImport }) => {
        const i = engines.BACKENDS.findIndex((b) => b.id === id);
        const real = i >= 0 ? engines.BACKENDS.splice(i, 1)[0] : null;
        let seen = null;
        const stub = { id, label: "桩", bin: null, note: "", install: "", launchHeader: "", supportsResume: true, models: [],
          async detect() { return { id, installed: true, path: "", version: "0" }; },
          async run(o) {
            seen = { cwd: o.cwd, resumeId: o.resumeId, forkSession: o.forkSession, seedRollout: o.seedRollout, prompt: o.prompt, sys: o.systemPrompt || "" };
            return { finalText: "好", usage: {}, stopped: null, sessionId: FORKED };
          },
          ...extra };
        engines.BACKENDS.push(stub);
        try {
          const llm = { provider: "mock", model: "scripted", async chat() { return { text: "内置答的", toolCalls: [], stopReason: "end" }; } };
          const rt = createAgentRuntime({ config: { agent: { engine: id, max_steps: 3, engine_options: { [id]: { model: "m1" } } } }, llm, mcpManager: new McpManager(), experts: [] });
          const notices = [];
          await rt.runTask({ history, engineSession, engineImport, emit(e) { if (e && e.notice) notices.push(String(e.text)); } });
          return { seen: seen || {}, notices };
        } finally {
          engines.BACKENDS.splice(engines.BACKENDS.indexOf(stub), 1);
          if (real) engines.BACKENDS.splice(i, 0, real);
        }
      };
      const hist = () => [{ role: "user", content: "旧" }, { role: "assistant", text: "旧答" }, { role: "user", content: "接着来" }];
      const yes = await runStub("claude-code", { async canFork() { return true; } }, { history: hist(), engineSession: A, engineImport: { cwd: PROJ, fork: true } });
      ok(yes.seen.cwd === PROJ && yes.seen.resumeId === A && yes.seen.forkSession === true, "Claude Code：在原文件夹里、--resume 原来那条、分出新的", yes.seen);
      ok(/原来在终端里跟你干活的那个文件夹/.test(yes.seen.sys) && !/成果面板/.test((yes.seen.sys.match(/.*工作目录是.*/) || [""])[0]), "提示词照实说：这是用户原来的文件夹，不说进成果面板");
      eq(yes.seen.prompt, "接着来", "接原来那根线：只发新的那句");
      const no = await runStub("claude-code", {}, { history: hist(), engineSession: A, engineImport: { cwd: PROJ, fork: true } });
      ok(!no.seen.resumeId && no.seen.forkSession === false && no.notices.some((t) => /分不出新会话/.test(t)), "这版分不出新会话：不续原来那条，前面的当背景，说一声", { seen: no.seen, notices: no.notices });
      ok(/旧答/.test(no.seen.prompt || ""), "不续的时候前面的对话摊平带过去");
      const gone = await runStub("claude-code", { async canFork() { return true; } }, { history: hist(), engineSession: A, engineImport: { cwd: GONE, fork: true } });
      ok(gone.seen.cwd !== GONE && !gone.seen.resumeId && gone.seen.forkSession === false, "原文件夹刚好没了：不在那儿跑，也不续原来那条", gone.seen);
      ok(!fs.existsSync(GONE), "没替用户把没了的文件夹建出来");
      const cx = await runStub("codex", {}, { history: hist(), engineSession: G, engineImport: { cwd: PROJ, rollout: FILES.G } });
      ok(cx.seen.cwd === PROJ && cx.seen.resumeId === G && cx.seen.seedRollout === FILES.G && !cx.seen.forkSession, "Codex：在原文件夹里、续原来那条、带上要复制的原文件", cx.seen);
      const plainRun = await runStub("claude-code", {}, { history: [{ role: "user", content: "新任务" }], engineSession: null, engineImport: null });
      ok(plainRun.seen.cwd !== PROJ && plainRun.seen.forkSession === false && plainRun.seen.seedRollout === "", "没导入过的任务：照旧在任务文件夹里，什么都不多带", plainRun.seen);

      // 真的 claude-code.js：拿一个假 claude 看命令行
      const claude = require(mod("claude-code"));
      const binDir = sub("bin");
      const argvFile = path.join(binDir, "argv.json");
      const fake = (name, help) => {
        const f = path.join(binDir, name);
        fs.writeFileSync(f, "#!/usr/bin/env node\n" + [
          "const a = process.argv.slice(2);",
          `if (a[0] === "--version") { console.log("2.1.0 (Claude Code)"); process.exit(0); }`,
          `if (a[0] === "--help") { console.log(${JSON.stringify(help)}); process.exit(0); }`,
          `require("fs").writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(a));`,
          `process.stdout.write(${JSON.stringify(L({ type: "result", subtype: "success", is_error: false, result: "好", session_id: FORKED }) + "\n")});`,
        ].join("\n"));
        fs.chmodSync(f, 0o755);
        return f;
      };
      const newBin = fake("claude-new", "Options:\n  --resume <id>\n  --fork-session  Create a new session ID\n  --add-dir <dirs>");
      const oldBin = fake("claude-old", "Options:\n  --resume <id>\n  --add-dir <dirs>");
      ok((await claude.canFork({ bin: newBin })) === true && (await claude.canFork({ bin: oldBin })) === false, "canFork 按 --help 里有没有 --fork-session 判");
      await claude.run({ prompt: "hi", cwd: PROJ, bin: newBin, model: "sonnet", resumeId: A, forkSession: true });
      let argv = [];
      try { argv = JSON.parse(fs.readFileSync(argvFile, "utf8")); } catch {}
      const k = argv.indexOf("--resume");
      ok(k >= 0 && argv[k + 1] === A && argv.includes("--fork-session"), "命令行带着 --resume 原 id 和 --fork-session", argv.filter((x) => x.startsWith("--")));
      fs.rmSync(argvFile, { force: true });
      let err = null;
      try { await claude.run({ prompt: "hi", cwd: PROJ, bin: oldBin, model: "sonnet", resumeId: A, forkSession: true }); } catch (e) { err = e; }
      ok(err && /不能分出新会话/.test(err.message) && !fs.existsSync(argvFile), "老版不认 --fork-session：宁可不跑，不往原来那份记录里续写", err && err.message);
      await claude.run({ prompt: "hi", cwd: PROJ, bin: oldBin, model: "sonnet", resumeId: FORKED });
      try { argv = JSON.parse(fs.readFileSync(argvFile, "utf8")); } catch { argv = []; }
      ok(argv.includes("--resume") && !argv.includes("--fork-session"), "平常续自己的线：不带 --fork-session，老版照样跑");

      // Codex：原文件复制进隔离运行窝
      const codex = require(mod("codex"));
      const home = sub("codex-home");
      ok(codex._internals.stageRollout(home, G, FILES.G) === true, "rollout 复制进隔离运行窝");
      const copy = path.join(home, "sessions", "2026", "10", "02", path.basename(FILES.G));
      ok(fs.existsSync(copy) && sha(copy) === HASH_BEFORE.G && fs.statSync(copy).ino !== fs.statSync(FILES.G).ino, "照原来的 年/月/日 摆、内容一样、不是硬链接");
      ok(codex._internals.stageRollout(home, G, FILES.G) === true && codex._internals.rolloutFile(home, G) === copy, "再来一次：已经有了就不再复制");
      ok(codex._internals.stageRollout(home, H, FILES.G) === false && codex._internals.stageRollout(home, "../x", FILES.G) === false, "id 和文件名对不上、id 不合规：不复制");
      eq(sha(FILES.G), HASH_BEFORE.G, "原文件一个字节没变");
    });

    await section("⑨ 接线", async () => {
      const S = src("server");
      ok(/createSessionImportRouter\(\{\s*isOwner:\s*isPlatformOwner\s*}/.test(S), "server.js 挂路由用的是 isPlatformOwner");
      ok(/sessionImport\.continuePlan\(sess,\s*\{\s*engine:\s*laneEngine,\s*owner:\s*isPlatformOwner\(req\)/.test(S), "/api/chat 每一轮先问 continuePlan，主人按 isPlatformOwner 判");
      ok(/engineSession:\s*imPlan\.engineSession,/.test(S) && /engineImport:\s*imPlan\.engineImport,/.test(S), "runTask 拿的是 continuePlan 给的线和文件夹");
      const admin = require(mod("admin"));
      ok(admin.PLATFORM_WRITE.includes("/api/import/") && admin.PLATFORM_READ.includes("/api/import/"), "/api/import/ 进了平台读写两张表（两道闸都得过）");
      const fe = fs.readFileSync(path.join(__dirname, "..", "public", "js", "app-01.js"), "utf8");
      ok(!/offerLocalImport|openLocalImport|empty-import|\/api\/import\/local/.test(fe), "空白页不扫描本机会话，也没有导入入口");
      ok(!/sessionImport\.createSessionImporter\(/.test(S), "服务启动不创建本机会话扫描器");
    });

    await section("★反向对照★", async () => {
      const routeFile = require.resolve(mod("routes/session-import"));
      const openRouter = mutant(routeFile, GATE_LINE, "");
      const mutOut = sub("mut-route");
      const open = await serve(openRouter.createSessionImportRouter({ enabled: true, isOwner, importer: si.createSessionImporter({ sessionFile: sessFile(mutOut), sessionDirs: [mutOut], ledgerFile: path.join(mutOut, "ledger.json") }) }));
      servers.push(open);
      const leak = await call(open, "GET", "/api/import/local", "alice");
      ok(leak.status === 200 && Array.isArray(leak.body.sources), "★反向对照★ 去掉主人检查：成员也能看到条数（测试必须红）", leak.status);

      const impFile = require.resolve(mod("session-import"));
      const noDedup = mutant(impFile, DEDUP_LINE, "return false;");
      const out = sub("mut-dedup");
      const imp = noDedup.createSessionImporter({ sessionFile: sessFile(out), sessionDirs: [out], ledgerFile: path.join(out, "ledger.json") });
      for (let round = 0; round < 2; round++) {
        await imp.start("claude-code", { ids: [B] });
        const end = Date.now() + 10000;
        while (imp.job() && imp.job().state === "running" && Date.now() < end) await sleep(10);
      }
      eq(importedIn(out).filter((x) => x.rec.imported.id === B).length, 2, "★反向对照★ 去掉去重：同一条导两次出两份（测试必须红）");
    });

    finished = true;
  } finally {
    for (const s of servers) await new Promise((r) => s.close(() => r()));
    console.log(`\n${fail ? "✗" : "✓"} 导入本机会话：${pass} 过 / ${fail} 挂`);
    process.exitCode = fail ? 1 : 0;
    void HOME;
  }
})();
