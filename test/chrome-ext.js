// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 OpenWorkBuddy Contributors · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * Chrome 扩展本身（extension/chrome/）。不起真 Chrome：chrome.* 全是假的，后台脚本放进 vm 里跑，
 * 连的是同一进程里起的真 chrome-link；注进网页的 page-ops.js 跑在一个假页面里（照 Chrome 那样把函数按源码搬过去）。
 *
 *   ① 清单：权限只要这四样，网页发不了消息给它，没有常驻注入的脚本
 *   ② page-ops：哪些网址不碰（跟服务端那份一字不差）、哪些框不填；读、点、输入、滚、找；注两次不炸；填过的不往回读
 *   ③ 后台：没配对就歇着；只听自己弹窗的；配对码换令牌（地址、配对码的各种写法）
 *   ④ 每一步：标签页过滤、打开、页面换了网站不做、点完看跳没跳、截屏切过去再切回来、等的时候叫停、Chrome 的英文错换人话
 *   ⑤ 断线：令牌失效说清楚；被同账号另一个 Chrome 顶掉就停下不抢；服务重启自己连回去；设置页断开、弹窗断开回到没配对
 *
 *   node test/chrome-ext.js
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const vm = require("vm");
const { mod, ROOT } = require("./lib/mod");
// 赶在 require 生产模块之前：配对记录落进临时家
const HOME = require("./lib/own-home")("chrome-ext");
const chromeLink = require(mod("chrome-link"));
const chromeTools = require(path.join(ROOT, "src", "tools", "chrome.js"));
const { open, browserSocket } = require("./lib/ws-client");

let pass = 0, fail = 0, finished = false;
const ok = (cond, msg, detail) => {
  if (cond) { pass++; console.log("  ✅ " + msg); }
  else { fail++; console.log("  ❌ " + msg + (detail === undefined ? "" : "：" + JSON.stringify(detail).slice(0, 600))); }
};
const section = (t) => console.log("\n" + t);
process.on("exit", (code) => {
  if (!finished) { fail++; console.log(`\n  ❌ 这套测试没跑完就退了（跑到第 ${pass + fail - 1} 条）`); }
  console.log(`\n${pass} 通过，${fail} 失败`);
  if (fail && !code) process.exitCode = 1;
});

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms) => Promise.race([p, delay(ms).then(() => null)]);
async function until(fn, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return true; await delay(20); }
  return !!(await fn());
}

const EXT = path.join(ROOT, "extension", "chrome");
const src = (f) => fs.readFileSync(path.join(EXT, f), "utf8");
const MANIFEST = JSON.parse(src("manifest.json"));
const EXT_ID = "abcdefghijklmnopabcdefghijklmnop";
const ORIGIN = "chrome-extension://" + EXT_ID;

// ── 假页面：只做 page-ops.js 用到的那几样 DOM ──
function makePage(tab, { silent = false, noScript = false, text = "首页\n欢迎来到这里" } = {}) {
  const events = [];
  class El {
    constructor(tag, attrs = {}, more = {}) {
      this.tagName = tag.toUpperCase();
      this.attrs = attrs;
      this.id = attrs.id || "";
      this.isConnected = true;
      this.disabled = !!more.disabled;
      this.readOnly = false;
      this.labels = null;
      this.parentElement = null;
      this.innerText = more.text || "";
      this.href = attrs.href || "";
      this.form = more.form || null;
      this.onClick = more.onClick || null;
      this._value = "";
    }
    get type() { return this.attrs.type || (this.tagName === "INPUT" ? "text" : ""); }
    get isContentEditable() { return false; }
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
    getBoundingClientRect() { return { width: 120, height: 24, top: 40, bottom: 64, left: 10, right: 130 }; }
    matches() { return true; }
    closest() { return null; }
    querySelector() { return null; }
    scrollIntoView() {}
    focus() { events.push("focus:" + this.who()); }
    dispatchEvent(e) { events.push(e.type + ":" + this.who()); return true; }
    click() { events.push("click:" + this.who()); if (this.onClick) this.onClick(); }
    who() { return this.attrs.name || this.innerText; }
  }
  class Field extends El {
    get value() { return this._value; }
    set value(v) { this._value = String(v); }
  }
  class Ev { constructor(type, init = {}) { this.type = type; Object.assign(this, init); } }
  const form = { requestSubmit: () => events.push("submit") };
  const els = [
    new El("button", {}, { text: "Search", onClick: () => nav(tab, "https://github.com/search?q=owb", "搜索结果", 2) }),
    new Field("input", { name: "q", placeholder: "Query" }, { form }),
    new Field("input", { type: "password", name: "pass" }),
    new Field("input", { name: "card_no", placeholder: "卡号" }),
    new El("a", { href: "https://github.com/explore" }, { text: "Explore" }),
    new El("button", {}, { text: "灰的按钮", disabled: true }),
  ];
  const se = { scrollHeight: 3000, scrollTop: 0, clientHeight: 1000, scrollTo({ top }) { this.scrollTop = Math.max(0, Math.min(this.scrollHeight - 1000, top)); } };
  const document = {
    get title() { return tab.title; },
    body: { innerText: text },
    scrollingElement: se, documentElement: se,
    querySelectorAll: (sel) => (sel === "body *" ? [] : els),
    querySelector: () => null,
    getElementById: () => null,
  };
  const location = {
    get href() { return tab.url; },
    get origin() { return new URL(tab.url).origin; },
    get host() { return new URL(tab.url).host; },
  };
  const g = {
    URL, console, document, location, innerHeight: 1000,
    getComputedStyle: () => ({ visibility: "visible", display: "block", overflowY: "visible" }),
    HTMLInputElement: Field, HTMLTextAreaElement: Field,
    Event: Ev, InputEvent: Ev, KeyboardEvent: Ev, MouseEvent: Ev, PointerEvent: Ev,
  };
  g.window = g;
  const ctx = vm.createContext(g);
  return { ctx, events, els, document, silent, noScript };
}
function nav(t, url, title, loads = 1) {
  t.url = url;
  t.title = title;
  t.status = "loading";
  t.loads = loads;
}

(async () => {
  section("① 清单：要的权限就这几样");
  {
    ok(MANIFEST.manifest_version === 3 && MANIFEST.background.service_worker === "background.js" && MANIFEST.action.default_popup === "popup.html",
      "MV3，后台是 background.js，弹窗是 popup.html");
    ok(JSON.stringify([...MANIFEST.permissions].sort()) === JSON.stringify(["alarms", "scripting", "storage", "tabs"]),
      "权限只要 tabs / scripting / storage / alarms（不要 cookies、历史记录、调试器）", MANIFEST.permissions);
    ok(!MANIFEST.externally_connectable && !MANIFEST.content_scripts && !MANIFEST.web_accessible_resources,
      "网页发不了消息给它，也没有常驻注进每个页面的脚本");
    const listed = fs.readdirSync(EXT).filter((n) => !n.startsWith("."));
    ok(["background.js", "page-ops.js", "popup.html", "popup.js", "manifest.json"].every((n) => listed.includes(n)) && /<script src="popup\.js"><\/script>/.test(src("popup.html")),
      "引用到的文件都在", listed);
  }

  section("② page-ops：不碰的网址、不填的框、在页面里干活");
  {
    const P = (() => { const g = vm.createContext({ URL }); vm.runInContext(src("page-ops.js"), g, { filename: "page-ops.js" }); return g.OWBPage; })();
    const SAMPLE = ["https://github.com/", "http://example.com:8080/x", "chrome://settings", "chrome-extension://abc/popup.html", "file:///etc/hosts",
      "about:blank", "data:text/html,hi", "javascript:alert(1)", "view-source:https://github.com/", "https://chromewebstore.google.com/detail/x",
      "https://chrome.google.com/webstore/category", "https://chrome.google.com/search", "ftp://example.com/", "不是网址"];
    const diff = SAMPLE.filter((u) => P.blockedUrl(u, "") !== chromeTools.blockedUrl(u, { isOwnUrl: () => false }));
    ok(!diff.length, "不碰哪些网址：扩展这份跟服务端那份一字不差", diff);
    const blockedOnes = SAMPLE.filter((u) => P.blockedUrl(u, ""));
    ok(blockedOnes.length === 11 && !P.blockedUrl("https://chrome.google.com/search", "") && !P.blockedUrl("https://github.com/", ""),
      "浏览器内部页、本机文件、扩展页、data:/javascript:、扩展商店都不碰；普通网站照常", blockedOnes);
    const LOCAL = "http://127.0.0.1:3800";
    ok(P.blockedUrl("http://localhost:3800/#/settings", LOCAL).includes("OpenWorkBuddy 自己的页面") && P.blockedUrl("http://[::1]:3800/", LOCAL) &&
      !P.blockedUrl("http://127.0.0.1:3801/", LOCAL) && P.blockedUrl("https://owb.example.com/x", "https://owb.example.com") && !P.blockedUrl("https://github.com/", "https://owb.example.com"),
      "OWB 自己的页面不碰：本机几种写法同端口算一个，反代后面按域名认");
    const S = [
      [{ type: "password" }, "密码框"], [{ autocomplete: "current-password" }, "密码框"], [{ name: "pwd" }, "密码框"], [{ label: "登录密码" }, "密码框"],
      [{ autocomplete: "cc-number" }, "银行卡信息"], [{ placeholder: "请输入卡号" }, "银行卡信息"], [{ name: "cvv" }, "银行卡信息"],
      [{ label: "身份证号" }, "证件号"], [{ name: "passport_no" }, "证件号"],
      [{ autocomplete: "one-time-code" }, "验证码"], [{ placeholder: "短信验证码" }, "验证码"],
      [{ name: "q", placeholder: "搜索" }, ""], [{ type: "email", name: "email" }, ""], [{ name: "title" }, ""],
    ];
    const wrong = S.filter(([a, want]) => P.sensitiveWhy(a) !== want).map(([a, want]) => [a, want, P.sensitiveWhy(a)]);
    ok(!wrong.length, "密码、银行卡、证件、验证码这类框认得出来，普通框不误伤", wrong);

    const tab = { id: 1, url: "https://github.com/", title: "GitHub", status: "complete" };
    const pg = makePage(tab);
    vm.runInContext(src("page-ops.js"), pg.ctx);
    const refsBefore = vm.runInContext("globalThis.__owbRefs", pg.ctx);
    let twice = true;
    try { vm.runInContext(src("page-ops.js"), pg.ctx); } catch { twice = false; }
    const run = (cmd, a) => JSON.parse(JSON.stringify(pg.ctx.OWBPage.run(cmd, a)));
    const r = run("read", {});
    ok(twice && r.title === "GitHub" && r.url === "https://github.com/" && r.text === "首页\n欢迎来到这里" && r.elements.length === 6 && vm.runInContext("globalThis.__owbRefs", pg.ctx) !== undefined,
      "同一个页面注两次不炸，读得到标题、网址、正文、能点能填的东西", { twice, n: r.elements && r.elements.length });
    const by = (name) => r.elements.find((e) => e.name === name) || {};
    ok(by("Query").kind === "input" && !by("Query").sensitive && by("pass").sensitive === "密码框" && by("卡号").sensitive === "银行卡信息" &&
      by("Explore").kind === "link" && by("Explore").href === "https://github.com/explore" && by("灰的按钮").disabled === true && by("Search").kind === "button",
      "列出来的元素带编号、种类；密码框、卡号框标出来，灰的按钮标灰", r.elements);
    ok(refsBefore === undefined && vm.runInContext("globalThis.__owbRefs.n", pg.ctx) === 6, "编号存在页面自己的隔离环境里，读一遍编一遍号");
    const t1 = run("type", { ref: by("Query").ref, text: "hello", submit: true });
    const q = pg.els[1];
    ok(t1.typed === 5 && q.value === "hello" && pg.events.includes("input:q") && pg.events.includes("change:q") && pg.events.includes("keydown:q") && pg.events.includes("submit"),
      "输入：值写进去、发 input/change，要提交就回车并交表单", pg.events);
    const t2 = run("type", { ref: by("Query").ref, text: " world", clear: false });
    ok(t2.typed === 6 && q.value === "hello world", "clear:false 接在后面写", q.value);
    const again = JSON.stringify(run("read", {}));
    ok(!again.includes("hello"), "框里填过的内容，读页面时不往回读");
    const t3 = run("type", { ref: by("pass").ref, text: "abc" });
    ok(t3.code === "sensitive" && t3.error.includes("密码框") && pg.els[2].value === "", "密码框：页面里再核一遍，不填", t3);
    const t4 = run("type", { ref: by("卡号").ref, text: "4111" });
    ok(t4.code === "sensitive" && pg.els[3].value === "", "卡号框：不填", t4);
    const n0 = pg.events.length;
    const c1 = run("click", { ref: by("Search").ref });
    const fired = pg.events.slice(n0);
    ok(c1.clicked && ["pointerdown:Search", "mousedown:Search", "pointerup:Search", "mouseup:Search", "click:Search"].every((x) => fired.includes(x)),
      "点：按下、抬起、click 依次发", fired);
    ok(run("click", { ref: by("灰的按钮").ref }).code === "disabled" && run("click", { ref: "e999" }).code === "stale" && run("type", { ref: "e999", text: "x" }).code === "stale",
      "灰的按钮不点；页面上已经没有的编号不瞎点");
    const s1 = run("scroll", { direction: "down" });
    const s2 = run("scroll", { direction: "bottom" });
    const s3 = run("scroll", { direction: "top" });
    ok(s1.y === 850 && s1.viewport === 1000 && s1.height === 3000 && !s1.atEnd && s2.y === 2000 && s2.atEnd && s3.y === 0, "滚动：一屏是可视高度的八成半，到底、回顶", [s1, s2, s3]);
    ok(run("find", { text: "欢迎" }).found === true && run("find", { text: "没有这句" }).found === false, "找字：有就有，没有就没有");
    const mv = run("read", { expectOrigin: "https://evil.example" });
    ok(mv.code === "moved" && mv.error.includes("页面已经换成了 github.com"), "页面里再核一遍网站：不是批准的那个就不做", mv);
    ok(run("nope", {}).code === "unknown", "不认识的一步：说更新扩展");
  }

  // ── 假 Chrome ──
  const tabs = [];
  const pages = new Map();
  const caps = [];
  const injected = [];
  const created = [];
  let nextTab = 10;
  const tabOf = (id) => tabs.find((t) => t.id === Number(id));
  const activate = (t) => { for (const x of tabs) if (x.windowId === t.windowId) x.active = x === t; };
  function addTab(t, page = {}) {
    const tab = { windowId: 1, active: false, status: "complete", title: "", ...t };
    tabs.push(tab);
    pages.set(tab.id, makePage(tab, page));
    return tab;
  }
  const snap = (t) => {
    const c = { ...t };
    delete c.loads;
    if (t.status === "loading" && --t.loads <= 0) t.status = "complete";
    return c;
  };
  const store = {};
  const listeners = { message: [], alarm: [] };
  const alarms = new Map();
  const badges = [];
  const sent = [];
  const { WebSocket: BaseWS, made } = browserSocket(ORIGIN);
  class WS extends BaseWS {
    send(t) { try { sent.push(JSON.parse(t)); } catch {} super.send(t); }
  }
  const chromeApi = {
    runtime: {
      id: EXT_ID,
      getManifest: () => ({ ...MANIFEST }),
      onMessage: { addListener: (f) => listeners.message.push(f) },
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
    },
    storage: {
      local: {
        get: async (keys) => { const out = {}; for (const k of [].concat(keys)) if (k in store) out[k] = store[k]; return out; },
        set: async (o) => { Object.assign(store, o); },
        remove: async (keys) => { for (const k of [].concat(keys)) delete store[k]; },
      },
    },
    action: { setBadgeText: (o) => badges.push(o.text), setBadgeBackgroundColor: () => {} },
    alarms: {
      get: async (n) => alarms.get(n),
      create: (n, info) => { alarms.set(n, { name: n, ...info }); },
      onAlarm: { addListener: (f) => listeners.alarm.push(f) },
    },
    tabs: {
      async query(q = {}) {
        return tabs.filter((t) => (q.active === undefined || t.active === q.active) && (q.windowId === undefined || t.windowId === q.windowId) &&
          (!q.lastFocusedWindow || t.windowId === 1)).map((t) => ({ ...t, loads: undefined }));
      },
      async get(id) { const t = tabOf(id); if (!t) throw new Error(`No tab with id: ${id}.`); return snap(t); },
      async update(id, p) {
        const t = tabOf(id);
        if (!t) throw new Error(`No tab with id: ${id}.`);
        if (p.url) nav(t, p.url, "页面 " + new URL(p.url).host);
        if (p.active) activate(t);
        return { ...t };
      },
      async create(p) {
        created.push(p);
        const t = addTab({ id: nextTab++, url: p.url, title: "页面 " + new URL(p.url).host, status: "loading", loads: 1 });
        if (p.active) activate(t);
        return { ...t };
      },
      async captureVisibleTab(windowId, opts) {
        const act = tabs.find((t) => t.windowId === windowId && t.active);
        caps.push({ windowId, opts, activeId: act && act.id });
        return "data:image/jpeg;base64,QUJD";
      },
    },
    scripting: {
      async executeScript({ target, files, func, args }) {
        const t = tabOf(target.tabId);
        if (!t) throw new Error(`No tab with id: ${target.tabId}.`);
        const pg = pages.get(t.id);
        if (pg.noScript) throw new Error("Cannot access contents of the page. Extension manifest must request permission to access the respective host.");
        injected.push({ tabId: t.id, frameIds: target.frameIds, what: files ? "files:" + files.join() : "func" });
        if (files) { for (const f of files) vm.runInContext(src(f), pg.ctx, { filename: f }); return [{ frameId: 0 }]; }
        // Chrome 是把函数按源码搬进页面里跑的：闭包带不过去，参数、结果都走一遍序列化
        const fn = vm.runInContext("(" + func.toString() + ")", pg.ctx);
        const r = fn(...JSON.parse(JSON.stringify(args || [])));
        return [{ frameId: 0, result: pg.silent || r === undefined ? undefined : JSON.parse(JSON.stringify(r)) }];
      },
    },
  };

  const server = http.createServer((_req, res) => { res.statusCode = 404; res.end("not here"); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const ADDR = `http://127.0.0.1:${port}`;
  chromeLink._reset({ dir: path.join(HOME, "chrome-link") });
  chromeLink.attach(server);

  addTab({ id: 1, url: "https://github.com/", title: "GitHub", active: true });
  addTab({ id: 2, url: "chrome://settings/", title: "设置" });
  addTab({ id: 3, url: `${ADDR}/`, title: "OpenWorkBuddy" });
  addTab({ id: 4, url: "https://shop.example/cart", title: "购物车" }, { silent: true });
  addTab({ id: 5, url: "https://bank.example/", title: "网银", windowId: 2, active: true }, { noScript: true });

  const bg = {
    chrome: chromeApi, WebSocket: WS, URL, console, setTimeout, clearTimeout, setInterval, clearInterval,
    navigator: { userAgentData: { platform: "macOS" } },
  };
  bg.importScripts = (...files) => { for (const f of files) vm.runInContext(src(f), bg, { filename: f }); };
  vm.createContext(bg);
  vm.runInContext(src("background.js"), bg, { filename: "background.js" });

  const popup = (msg, sender = { id: EXT_ID }) => new Promise((resolve) => {
    const keep = listeners.message[0](msg, sender, (r) => resolve(JSON.parse(JSON.stringify(r))));
    if (keep !== true) resolve({ ignored: keep });
  });
  const status = () => popup({ type: "status" });
  async function untilStatus(pred, ms = 3000) {
    let s = null;
    await until(async () => { s = await status(); return pred(s); }, ms);
    return s && pred(s) ? s : null;
  }
  const call = (op, args = {}, opts) => chromeLink.call("alice", op, args, opts);

  section("③ 后台：没配对就歇着；只听自己弹窗的；配对码换令牌");
  {
    const s0 = await status();
    ok(s0.state === "idle" && s0.paired === false && s0.addr === "http://127.0.0.1:3800" && s0.version === MANIFEST.version && made.length === 0,
      "刚装上、没配对：歇着，一条连接都不开（默认地址是本机 3800）", s0);
    ok(alarms.get("owb-keepalive") && alarms.get("owb-keepalive").periodInMinutes === 0.5, "挂了半分钟一次的闹钟兜底重连");
    const fromPage = await popup({ type: "status" }, { id: EXT_ID, tab: { id: 1 } });
    const fromOther = await popup({ type: "unpair" }, { id: "otherextensionidotherextensionid" });
    ok(fromPage.ignored === false && fromOther.ignored === false, "网页里、别的扩展发来的消息：不理", [fromPage, fromOther]);
    const bad1 = await popup({ type: "pair", addr: "ftp://x", code: "ABCD-EFGH" });
    const bad2 = await popup({ type: "pair", addr: ADDR, code: "ABC" });
    ok(bad1.error === "地址看不懂：要像 http://127.0.0.1:3800 这样" && bad2.error === "配对码是 8 位，像 ABCD-EFGH" && made.length === 0,
      "地址、配对码写得不对：先说清楚，不去连", [bad1, bad2]);
    const nobody = await popup({ type: "pair", addr: "127.0.0.1:1", code: "ABCD-EFGH" });
    ok(nobody.ok === false && nobody.error === "连不上 OpenWorkBuddy：看看地址对不对、它开着没有", "那个地址上没人：说连不上，看看地址", nobody);
    const wrong = await popup({ type: "pair", addr: ADDR, code: "ZZZZ-ZZZZ" });
    ok(wrong.ok === false && wrong.error === "配对码不对或者过期了，回设置页重新生成一个" && (await status()).state === "error" && badges[badges.length - 1] === "!",
      "配对码不对：把服务端的话原样告诉用户，图标上挂个感叹号", wrong);
    const { code } = chromeLink.newPairCode("alice");
    const good = await popup({ type: "pair", addr: `127.0.0.1:${port}/#/settings`, code: code.toLowerCase().replace("-", " ") });
    const s1 = await status();
    ok(good.ok === true && good.owner === "alice" && /^owbc_[A-Za-z0-9_-]{43}$/.test(store.token || "") && store.addr === ADDR &&
      s1.state === "online" && s1.owner === "alice" && s1.paired && badges[badges.length - 1] === "", "配上了：地址规整成 http://主机:端口，令牌存进扩展自己的存储", { good, s1 });
    const st = chromeLink.status("alice");
    ok(st.connected && st.name === "Chrome · macOS" && st.version === MANIFEST.version, "服务端认得这台：叫什么、扩展版本", st);
  }

  section("④ 每一步：在假 Chrome 里做，结果按协议回");
  {
    const t = await call("tabs");
    ok(t.ok && JSON.stringify(t.data.tabs.map((x) => x.id)) === "[1,4,5]" && t.data.tabs[0].title === "GitHub" && t.data.tabs[0].active === true,
      "列标签页：chrome:// 和 OWB 自己的页面不列", t);
    const p0 = await call("peek");
    const p9 = await call("peek", { tab: 99 });
    ok(p0.ok && p0.data.id === 1 && p9.ok === false && p9.error === "找不到这个标签页（可能已经关了）", "不说哪个就是正在看的那个；关掉的标签页说人话", [p0, p9]);

    const r = await call("read", { tab: 1, expectOrigin: "https://github.com" });
    const inj = injected.filter((x) => x.tabId === 1);
    ok(r.ok && r.data.title === "GitHub" && r.data.elements.length === 6 && inj.length === 2 && inj[0].what === "files:page-ops.js" && inj[1].what === "func" &&
      inj.every((x) => JSON.stringify(x.frameIds) === "[0]"), "读页面：先把 page-ops.js 注进主框架，再调它", { ok: r.ok, inj });
    const n0 = injected.length;
    const moved = await call("read", { tab: 1, expectOrigin: "https://evil.example" });
    const blk = await call("read", { tab: 2 });
    const own = await call("read", { tab: 3 });
    ok(moved.code === "moved" && moved.error.includes("页面已经换成了 github.com") && blk.code === "blocked" && own.code === "blocked" && injected.length === n0,
      "网站跟批准的不一样、chrome://、OWB 自己的页面：一行脚本都不注", [moved, blk, own]);
    const silent = await call("read", { tab: 4 });
    const noScript = await call("read", { tab: 5 });
    ok(silent.error === "页面没回话（可能正在跳转），等一下再试" && noScript.error === "这个页面 Chrome 不让扩展碰", "Chrome 报的错、页面不回话：换成人话", [silent, noScript]);

    const refOf = (name) => (r.data.elements.find((e) => e.name === name) || {}).ref;
    const rv = await call("resolve", { tab: 1, ref: refOf("Query"), forType: true });
    ok(rv.ok && rv.data.found && rv.data.kind === "input" && rv.data.editable === true && rv.data.sensitive === "", "动手前看一眼要填的是哪个框", rv);
    const pg1 = pages.get(1);
    const ty = await call("type", { tab: 1, ref: refOf("Query"), text: "owb", submit: true, expectOrigin: "https://github.com" });
    ok(ty.ok && ty.data.navigated === false && pg1.els[1].value === "owb" && pg1.events.includes("submit"), "输入：填进去、回车，没跳页就说没跳", ty);
    const pw = await call("type", { tab: 1, ref: refOf("pass"), text: "secret" });
    ok(pw.code === "sensitive" && pg1.els[2].value === "", "密码框：服务端漏了，扩展这里也不填", pw);
    const ck = await call("click", { tab: 1, ref: refOf("Search"), expectOrigin: "https://github.com" });
    ok(ck.ok && ck.data.navigated === true && ck.data.url === "https://github.com/search?q=owb" && ck.data.title === "搜索结果", "点完跳页了：等它加载完，回新的标题和网址", ck);
    const gray = await call("click", { tab: 1, ref: refOf("灰的按钮") });
    ok(gray.code === "disabled" && gray.error === "这个按钮现在是灰的，点不了", "灰的按钮：说点不了", gray);
    const sc = await call("scroll", { tab: 1, direction: "down" });
    ok(sc.ok && sc.data.y === 850 && sc.data.height === 3000, "滚动：回滚到哪、页面多高", sc);

    const op = await call("open", { url: "https://github.com/explore" });
    ok(op.ok && op.data.id === 10 && op.data.url === "https://github.com/explore" && created.length === 1 && created[0].active === true && tabOf(10).active,
      "打开网址：新开一个标签页，等它加载完", op);
    const c0 = created.length;
    const bad = [await call("open", { url: "chrome://settings" }), await call("open", { url: `http://localhost:${port}/` }),
      await call("open", { url: "https://chromewebstore.google.com/" }), await call("open", { url: "https://github.com/", tab: 2 })];
    ok(bad.every((x) => x.code === "blocked") && created.length === c0 && tabOf(2).url === "chrome://settings/", "不碰的网址不打开；chrome:// 那个标签页也不拿来跳", bad);

    const sh = await call("shot", { tab: 1, expectOrigin: "https://github.com" });
    await until(() => tabOf(10).active, 2000);
    const cap = caps[caps.length - 1] || {};
    ok(sh.ok && /^data:image\/jpeg;base64,/.test(sh.data.dataUrl) && cap.activeId === 1 && cap.opts.format === "jpeg" && cap.opts.quality === 70 && tabOf(10).active,
      "截屏：先切到那个标签页截，截完切回用户原来在看的", { cap, active: tabs.filter((x) => x.active).map((x) => x.id) });

    setTimeout(() => { pg1.document.body.innerText += "\n加载完成"; }, 600);
    const w = await call("wait", { tab: 1, text: "加载完成", timeoutMs: 5000, expectOrigin: "https://github.com" });
    ok(w.ok && w.data.found === true, "等字出现：每半秒看一回，出现了就回", w);
    const w2 = await call("wait", { tab: 1, text: "永远不会有", timeoutMs: 1000 });
    ok(w2.ok && w2.data.found === false, "等到点还没有：回没等到", w2);
    const ac = new AbortController();
    const finds0 = injected.length;
    const pend = call("wait", { tab: 1, text: "永远不会有", timeoutMs: 30000 }, { stopSignal: ac.signal, timeoutMs: 40000 });
    await delay(700);
    ac.abort();
    const stopped = await withTimeout(pend, 2000);
    const gotStop = await until(() => sent.some((m) => m.type === "result" && m.code === "stopped" && m.error === "任务已经停了"), 3000);
    const finds1 = injected.length;
    await delay(1100);
    ok(stopped && stopped.code === "stopped" && gotStop && finds1 > finds0 && injected.length === finds1, "等的时候任务叫停：扩展收到取消就不再找了", { stopped, gotStop, finds: [finds0, finds1, injected.length] });
    const un = await call("format_disk");
    ok(un.code === "unknown" && un.error === "扩展不认识这一步，更新一下扩展再试", "不认识的一步：不做，说更新扩展", un);
  }

  section("⑤ 断线：令牌失效、被顶掉、服务重启、断开");
  {
    const real = store.token;
    store.token = "owbc_" + "x".repeat(43);
    await popup({ type: "reconnect" });
    const s1 = await untilStatus((s) => s.state === "error");
    ok(s1 && s1.error === "配对失效了，回设置页重新配对" && s1.paired === false && !store.token, "令牌失效：删掉令牌，说回设置页重新配对", s1);
    store.token = real;
    await popup({ type: "reconnect" });
    ok(!!(await untilStatus((s) => s.state === "online")) && chromeLink.connected("alice"), "令牌对了点「重新连接」：连回来");

    const other = await open(port, { origin: ORIGIN });
    other.ws.json({ type: "hello", token: real, version: MANIFEST.version });
    const welcomed = await other.ws.next((m) => m.type === "welcome");
    const s2 = await untilStatus((s) => s.state === "error");
    ok(welcomed && s2 && s2.error === "这个账号在另一个 Chrome 上连上了，这里先停下" && s2.paired === true, "同账号另一个 Chrome 连上来：这边停下，令牌留着", s2);
    const m0 = made.length;
    for (const f of listeners.alarm) f({ name: "owb-keepalive" });
    await delay(300);
    ok(made.length === m0, "被顶掉以后闹钟响了也不自己连回去抢", made.length - m0);
    await popup({ type: "reconnect" });
    const s3 = await untilStatus((s) => s.state === "online");
    const oc = await withTimeout(other.ws.closed, 3000);
    ok(s3 && oc && oc.code === 4001, "用户点「重新连接」才连回来，另一个让位", oc);

    chromeLink.detach();
    const s4 = await untilStatus((s) => s.state === "connecting");
    ok(s4 && s4.error === "连不上 OpenWorkBuddy，过一会儿自动再试" && s4.paired, "OpenWorkBuddy 关了：说过一会儿自动再试，令牌留着", s4);
    const m1 = made.length;
    await until(() => made.length > m1, 2500);
    await delay(200);
    chromeLink.attach(server);
    const s5 = await untilStatus((s) => s.state === "online", 6000);
    ok(s5 && made.length >= m1 + 2 && chromeLink.connected("alice"), "连不上就退避着再试，服务回来自己连上", made.length - m1);

    chromeLink.disconnect("alice");
    const s6 = await untilStatus((s) => s.state === "idle" && !s.paired);
    const m2 = made.length;
    for (const f of listeners.alarm) f({ name: "owb-keepalive" });
    await delay(300);
    ok(s6 && !store.token && made.length === m2, "设置页点断开：扩展回到没配对、删掉令牌，闹钟响了也不连", s6);

    const { code } = chromeLink.newPairCode("alice");
    const again = await popup({ type: "pair", addr: ADDR, code });
    ok(again.ok && chromeLink.connected("alice"), "再配一次");
    const u = await popup({ type: "unpair" });
    const gone = await until(() => !chromeLink.paired("alice"), 3000);
    const s7 = await status();
    ok(u.ok && gone && !store.token && !store.owner && s7.state === "idle", "弹窗里点断开：服务端那条配对也作废", { u, gone, s7 });
  }

  chromeLink.detach();
  server.close();
  if (server.closeAllConnections) server.closeAllConnections();
})().catch((e) => { fail++; console.log("  ❌ 套件自己崩了：" + ((e && e.stack) || e)); }).then(() => {
  finished = true;
  process.exit(fail ? 1 : 0);
});
