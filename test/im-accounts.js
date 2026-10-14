// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 每个账号自己绑的消息渠道（im/im-accounts.js）。
 *
 * 2026-10-14 用户：「按道理就是每个人有自己的助理啊……各个消息渠道，都能绑定自己的渠道，而不是管理员设置的」。
 * 盯的几条线：
 *   1. 各存各的：A 填的密钥 B 看不见，回给页面的一律打码，打码原样交回来不许把真值冲掉
 *   2. 回调地址带随机号、谁的号进谁的实例；成员的通用 Webhook 没设密钥一律不收
 *   3. 进来的任务以本人身份跑，会话键带他自己的前缀，日志只有他看得见
 *   4. 推送：成员绑了能推的就只推他自己的，没绑退回服务器那套；指名 owner 时绝不落到别人那里
 *   5. 停用/待审核/删号的账号：页面接口拒、回调地址拒
 * 全程假引擎、假 fetch，不连任何外部服务。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { mod } = require("./lib/mod");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "owb-imacc-"));
process.env.OPENWORKBUDDY_DATA_DIR = path.join(TMP, "data");
fs.mkdirSync(process.env.OPENWORKBUDDY_DATA_DIR, { recursive: true });

const express = require("express");
const notify = require(mod("notify"));
const { createImRouter } = require(mod("im"));
const { createImAccounts } = require(mod("im-accounts"));
const imConfig = require(mod("im-config"));
const prefs = require(mod("prefs"));

let pass = 0, fail = 0;
const ok = (cond, msg, extra) => {
  if (cond) { pass++; console.log("  ✓ " + msg); }
  else { fail++; console.log("  ✗ " + msg + (extra !== undefined ? "  ← " + JSON.stringify(extra) : "")); }
};

(async () => {
  const realFetch = global.fetch;
  const hits = [];
  // 只拦群机器人地址；本测试自己的 HTTP 请求照常走
  global.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith("https://bot.invalid/")) { hits.push(u); return { ok: true, text: async () => "{}" }; }
    return realFetch(url, init);
  };

  const dir = path.join(TMP, "data", "im-accounts");
  const status = { alice: "", bob: "", carol: "账号已停用" };
  const ran = [];
  const runtime = {
    runTask: async (a) => { ran.push(a); return { finalText: "收到" }; },
  };
  const sessionsMap = new Map();
  const sessions = { has: (k) => sessionsMap.has(k), get: (k) => sessionsMap.get(k), set: (k, v) => sessionsMap.set(k, v), keys: () => [...sessionsMap.keys()], clear: () => 0, save() {} };
  const config = { im: { wecom_bot_webhook: "https://bot.invalid/global" }, models: [] };
  const boss = createImRouter({ config, runtime, sessions, outputFiles: () => [] });
  const acc = createImAccounts({
    config, dir,
    problemOf: (u) => (u in status ? status[u] : "账号已删除"),
    canOwn: (u) => u.username !== "boss",
    makeInstance: ({ owner, config: view, saveConfig }) => createImRouter({
      config: view, owner, base: "", shared: boss.shared, sessions, outputFiles: () => [], saveConfig,
      runtime: { runTask: (a) => runtime.runTask({ ...a, user: owner }) },
      scope: (fn) => Promise.resolve().then(fn),
    }),
  });
  notify.setMemberCheck((name) => name === "alice" || name === "bob" || name === "dave");

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { const n = req.get("x-user"); if (n) req.user = { username: n, role: n === "boss" ? "admin" : "member" }; next(); });
  app.use(acc.router);
  app.use(boss.router);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, { user, body } = {}) => {
    const r = await realFetch(base + p, { method, headers: { "content-type": "application/json", ...(user ? { "x-user": user } : {}) }, body: body ? JSON.stringify(body) : undefined });
    let j = null; try { j = await r.json(); } catch {}
    return { status: r.status, body: j };
  };

  try {
    console.log("\n① 各存各的、打码");
    const a0 = await call("GET", "/im/my/config", { user: "alice" });
    ok(a0.status === 200 && /^\/im\/u\/[0-9a-f]{24}\/task$/.test(a0.body.hooks.task), "成员拿得到自己的回调地址（带随机号）", a0);
    const b0 = await call("GET", "/im/my/config", { user: "bob" });
    ok(b0.body.hooks.task !== a0.body.hooks.task, "两个人的回调地址不一样");
    ok(!a0.body.hooks.task.includes("alice"), "回调地址里不带账号名");

    await call("POST", "/im/my/config", { user: "alice", body: { im: { webhook_secret: "s-alice", wecom_bot_webhook: "https://bot.invalid/alice", smtp: { host: "smtp.invalid", pass: "p-alice" } } } });
    const a1 = await call("GET", "/im/my/config", { user: "alice" });
    ok(a1.body.im.webhook_secret === imConfig.MASK && a1.body.im.smtp.pass === imConfig.MASK, "密钥回给页面时打码", a1.body.im);
    ok(!JSON.stringify(a1.body).includes("s-alice") && !JSON.stringify(a1.body).includes("p-alice"), "真值一个字都不回给页面");
    await call("POST", "/im/my/config", { user: "alice", body: { im: a1.body.im } });
    const recA = acc._internals.load("alice");
    ok(recA.im.webhook_secret === "s-alice" && recA.im.smtp.pass === "p-alice", "打码原样交回来，真值不被冲掉", recA.im);
    const b1 = await call("GET", "/im/my/config", { user: "bob" });
    ok(!b1.body.im.webhook_secret && !b1.body.im.wecom_bot_webhook, "B 看不见 A 填的任何东西", b1.body.im);
    ok(config.im.wecom_bot_webhook === "https://bot.invalid/global" && !config.im.webhook_secret, "服务器那套原样没动", config.im);
    const st = fs.statSync(acc._internals.fileOf("alice"));
    ok((st.mode & 0o077) === 0, "配置文件只有本人进程读得了（0600）", (st.mode & 0o777).toString(8));
    await call("POST", "/im/my/config", { user: "alice", body: { im: { feishu: { doc_app_id: "x" } } } });
    ok(!(acc._internals.load("alice").im.feishu || {}).doc_app_id, "成员改不了飞书云文档那套（那是服务器级的）");

    console.log("\n② 谁能进 /im/my");
    ok((await call("GET", "/im/my/config")).status === 401, "没登录：401");
    ok((await call("GET", "/im/my/config", { user: "boss" })).status === 400, "平台管理员：用的是服务器那套，400");
    ok((await call("GET", "/im/my/config", { user: "carol" })).status === 403, "停用的账号：403");
    ok((await call("GET", "/im/my/config", { user: "ghost" })).status === 403, "删掉的账号：403");
    const sv = await call("GET", "/im/my/status", { user: "alice" });
    ok(sv.status === 200 && sv.body.webhook.secret_set === true && sv.body.wecom.configured === true, "/im/my/status 看的是自己那套", sv.body);
    const sb = await call("GET", "/im/my/status", { user: "bob" });
    ok(sb.body.webhook.secret_set === false && sb.body.wecom.configured === false, "B 的状态里没有 A 的通道", sb.body);
    ok((await call("GET", "/im/my/log", { user: "alice" })).status === 404, "白名单外的路由不转发");

    console.log("\n③ 回调地址");
    const hookA = a0.body.hooks.task, hookB = b0.body.hooks.task;
    const noSecret = await call("POST", hookB, { body: { message: "hi" } });
    ok(noSecret.status === 403 && /还没设密钥/.test(noSecret.body.error), "成员没设密钥：这个地址不收任务", noSecret);
    const wrong = await call("POST", hookA, { body: { message: "hi", secret: "nope" } });
    ok(wrong.status === 403, "密钥不对：403");
    hits.length = 0;
    const good = await call("POST", hookA, { body: { message: "帮我查天气", secret: "s-alice" } });
    ok(good.status === 200 && good.body.reply === "收到", "密钥对：任务跑了，回复原样回来", good);
    const last = ran[ran.length - 1] || {};
    ok(last.user === "alice", "任务以本人身份跑", last.user);
    ok(String(last.sessionId).startsWith(`u_${prefs.keyOf("alice")}_`), "会话键带他自己的前缀", last.sessionId);
    for (let i = 0; i < 50 && !hits.length; i++) await new Promise((r) => setTimeout(r, 10));
    ok(hits.length === 1 && hits[0] === "https://bot.invalid/alice", "任务完成只推他自己的群，不落进服务器的群", hits);
    ok((await call("POST", "/im/u/000000000000000000000000/task", { body: { message: "x" } })).status === 404, "随机号对不上：404");
    ok((await call("POST", hookA.replace("/task", "/whatever"), { body: {} })).status === 404, "回调只放那四条");

    console.log("\n④ 日志各看各的");
    const la = await call("GET", "/im/log", { user: "alice" });
    ok(Array.isArray(la.body) && la.body.some((e) => e.text === "帮我查天气"), "A 看得到自己通道里的那条", la.body && la.body.length);
    const lb = await call("GET", "/im/log", { user: "bob" });
    ok(Array.isArray(lb.body) && !lb.body.some((e) => e.text === "帮我查天气"), "B 看不到", lb.body);

    console.log("\n⑤ 推送挑哪一套");
    hits.length = 0;
    await notify.pushBots(config, "日报", { user: "alice" });
    ok(hits.join() === "https://bot.invalid/alice", "A 绑了群：只推 A 的", hits);
    hits.length = 0;
    await notify.pushBots(config, "日报", { user: "dave" });
    ok(hits.join() === "https://bot.invalid/global", "D 一条都没绑：退回服务器那套", hits);
    hits.length = 0;
    await notify.withPushUser("alice", () => notify.pushBots(config, "提醒"));
    ok(hits.join() === "https://bot.invalid/alice", "没报名字时看当前是谁在跑", hits);
    hits.length = 0;
    await notify.pushBots(config, "x", { owner: "bob" });
    ok(hits.length === 0, "指名 owner 且他没绑：一条都不推，不落到服务器", hits);
    hits.length = 0;
    await notify.pushBots(config, "x", { user: "boss" });
    ok(hits.join() === "https://bot.invalid/global", "管理员照旧推服务器那套", hits);

    console.log("\n⑥ 停用以后");
    status.alice = "账号已停用";
    ok((await call("POST", hookA, { body: { message: "hi", secret: "s-alice" } })).status === 403, "停用后回调地址拒收");
    await acc.drop("alice");
    hits.length = 0;
    await notify.pushBots(config, "x", { user: "alice" });
    ok(hits.join() === "https://bot.invalid/global", "实例拆掉后插口也摘了", hits);
  } finally {
    server.close();
    acc._internals.stop();
    for (const u of [...acc._internals.live.keys()]) await acc.drop(u).catch(() => {});
    global.fetch = realFetch;
    fs.rmSync(TMP, { recursive: true, force: true });
  }
  console.log(`\n${pass} 过 / ${fail} 挂`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
