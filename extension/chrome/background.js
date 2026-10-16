// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 OpenWorkBuddy Contributors · 商业使用需授权：COMMERCIAL-LICENSE.md
/**
 * 扩展后台：跟 OpenWorkBuddy 之间保持一条 WebSocket，收到一步就在这个 Chrome 里做，做完回结果。
 *
 *   - 地址：桌面版是本机（默认 http://127.0.0.1:3800），服务器版填服务器地址
 *   - 头一回用设置页给的配对码换令牌；令牌只存在 chrome.storage.local，以后每次连上先报它
 *   - 20 秒一次心跳（也让 Chrome 别把后台睡掉）；断了按 1、2、4…30 秒退避重连，另有闹钟每半分钟兜底
 *   - 每一步要不要做、做到哪，OpenWorkBuddy 那边已经问过用户；这边只再挡一道：
 *     浏览器内部页面、本机文件、扩展页、扩展商店、OpenWorkBuddy 自己的页面不碰，页面换了网站就不做
 */
"use strict";
importScripts("page-ops.js");

const PAGE = globalThis.OWBPage;
const DEFAULT_ADDR = "http://127.0.0.1:3800";
const WS_PATH = "/browser-link/ws";
const PING_MS = 20000;
const ALARM = "owb-keepalive";

let ws = null;
let opening = false;
let state = "idle"; // idle 没配对 | connecting | online | error
let lastError = "";
let owner = "";
let addr = DEFAULT_ADDR;
let backoff = 1000;
let retryTimer = null;
let pingTimer = null;
let pairWaiter = null; // 弹窗那边等着配对结果
let parked = false; // 被同账号的另一个 Chrome 顶掉了：闹钟别自己连回去抢，等用户点「重新连接」
const cancelled = new Set();

const nap = (ms) => new Promise((r) => setTimeout(r, ms));
const oops = (code, message) => Object.assign(new Error(message), { code });
const hostOf = (u) => { try { return new URL(String(u)).host; } catch { return ""; } };
const originOf = (u) => { try { return new URL(String(u)).origin; } catch { return ""; } };

/** 用户填的地址规整成 http(s)://主机[:端口]；看不懂回空 */
function normAddr(s) {
  let t = String(s || "").trim();
  if (!t) return "";
  if (!/^[a-z]+:\/\//i.test(t)) t = "http://" + t;
  try {
    const u = new URL(t);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    return u.origin;
  } catch { return ""; }
}
function wsUrl(a) {
  const u = new URL(a);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = WS_PATH;
  u.search = "";
  u.hash = "";
  return u.href;
}
const blocked = (url) => PAGE.blockedUrl(url, addr);

function setState(s, err = "") {
  state = s;
  lastError = err;
  try {
    chrome.action.setBadgeText({ text: s === "error" ? "!" : "" });
    chrome.action.setBadgeBackgroundColor({ color: "#cf222e" });
  } catch {}
}

function send(o) {
  if (ws && ws.readyState === 1) { ws.send(JSON.stringify(o)); return true; }
  return false;
}

function stopTimers() {
  clearInterval(pingTimer);
  pingTimer = null;
  clearTimeout(retryTimer);
  retryTimer = null;
}

function scheduleRetry() {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => connect(), backoff);
  backoff = Math.min(30000, backoff * 2);
}

function settlePair(r) {
  const w = pairWaiter;
  pairWaiter = null;
  if (w) w(r);
}

/** 连上去：有配对码就配对，有令牌就报令牌，都没有就歇着 */
async function connect(pairCode = "") {
  if (pairCode) while (opening) await nap(50);
  if (opening || (ws && ws.readyState <= 1 && !pairCode)) return;
  opening = true;
  try {
    const saved = await chrome.storage.local.get(["addr", "token"]);
    addr = normAddr(saved.addr) || DEFAULT_ADDR;
    const token = String(saved.token || "");
    if (!pairCode && !token) { setState("idle"); return; }
    if (ws) { const old = ws; ws = null; try { old.close(1000, "again"); } catch {} }
    stopTimers();
    setState("connecting");
    let sock;
    try { sock = new WebSocket(wsUrl(addr)); } catch {
      setState("error", "地址不对，连不上");
      settlePair({ ok: false, error: lastError });
      return;
    }
    ws = sock;
    const version = chrome.runtime.getManifest().version;
    sock.onopen = () => {
      if (sock !== ws) return;
      const name = "Chrome" + (navigator.userAgentData && navigator.userAgentData.platform ? " · " + navigator.userAgentData.platform : "");
      sock.send(JSON.stringify(pairCode ? { type: "pair", code: pairCode, name, version } : { type: "hello", token, version }));
      pingTimer = setInterval(() => send({ type: "ping" }), PING_MS);
    };
    sock.onmessage = (ev) => { if (sock === ws) onMessage(ev.data); };
    sock.onclose = (ev) => { if (sock === ws) onClose(ev.code); };
  } finally {
    opening = false;
  }
}

async function onMessage(text) {
  let m;
  try { m = JSON.parse(String(text)); } catch { return; }
  if (!m || typeof m !== "object") return;
  if (m.type === "paired") {
    owner = String(m.owner || "");
    await chrome.storage.local.set({ token: String(m.token || ""), owner });
    backoff = 1000;
    setState("online");
    return settlePair({ ok: true, owner });
  }
  if (m.type === "welcome") {
    owner = String(m.owner || "");
    backoff = 1000;
    return setState("online");
  }
  if (m.type === "error") {
    lastError = String(m.message || "连接被拒绝了");
    return;
  }
  if (m.type === "unpaired") {
    await stopRecording(); recording = null;
    await chrome.storage.local.remove(["token", "owner"]);
    owner = "";
    return setState("idle");
  }
  if (m.type === "cancel") return void cancelled.add(String(m.id || ""));
  if (m.type === "call") return handleCall(m);
}

async function onClose(code) {
  await stopRecording("连接已断开，录制已停止");
  ws = null;
  stopTimers();
  if (code === 4401 || code === 4002) {
    await chrome.storage.local.remove(["token", "owner"]);
    owner = "";
  }
  if (code === 4002) setState("idle");
  else if (code === 4401) setState("error", lastError || "配对失效了，回设置页重新配对");
  else if (code === 4403 || code === 4500) setState("error", lastError || "配对没成功");
  else if (code === 4001) { parked = true; setState("error", "这个账号在另一个 Chrome 上连上了，这里先停下"); }
  else {
    const { token } = await chrome.storage.local.get(["token"]);
    if (token) { setState("connecting", "连不上 OpenWorkBuddy，过一会儿自动再试"); scheduleRetry(); }
    else setState(lastError ? "error" : "idle", lastError);
  }
  settlePair({ ok: false, error: lastError || "连不上 OpenWorkBuddy：看看地址对不对、它开着没有" });
}

// ── 每一步 ──

/** Chrome 报的英文错，换成人话 */
function human(e) {
  const s = String((e && e.message) || e || "");
  if (/No tab with id/i.test(s)) return "找不到这个标签页（可能已经关了）";
  if (/Cannot access|cannot be scripted|Missing host permission/i.test(s)) return "这个页面 Chrome 不让扩展碰";
  if (/showing error page/i.test(s)) return "这个页面没打开成（网络出错的页面）";
  if (/Tabs cannot be edited right now/i.test(s)) return "Chrome 正忙（可能在拖标签页），稍后再试";
  return s.slice(0, 300) || "没做成";
}

async function pickTab(tab) {
  if (tab != null) return chrome.tabs.get(Number(tab));
  let [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!t) [t] = await chrome.tabs.query({ active: true });
  if (!t) throw oops("no_tab", "没找到正在看的标签页");
  return t;
}

/** 动页面之前：不许碰的不碰；网站跟批准时不一样就不做 */
async function guard(a) {
  const t = await pickTab(a.tab);
  const why = blocked(t.url || t.pendingUrl || "");
  if (why) throw oops("blocked", why);
  if (a.expectOrigin && originOf(t.url) !== a.expectOrigin) throw oops("moved", `页面已经换成了 ${hostOf(t.url) || "别的地方"}，跟批准的不一样，这一步没做`);
  return t;
}

async function inPage(tabId, cmd, args) {
  const target = { tabId, frameIds: [0] };
  await chrome.scripting.executeScript({ target, files: ["page-ops.js"] });
  const [r] = await chrome.scripting.executeScript({ target, func: (c, a) => globalThis.OWBPage.run(c, a), args: [cmd, args] });
  const v = r && r.result;
  if (!v) throw oops("failed", "页面没回话（可能正在跳转），等一下再试");
  if (v.error) throw oops(v.code || "failed", v.error);
  return v;
}

/** 等页面加载完；先等它真开始跳（刚改完网址那一下 status 可能还是旧页面的 complete） */
async function waitLoad(id, ms) {
  const start = Date.now();
  let moving = false;
  for (;;) {
    const t = await chrome.tabs.get(id);
    if (t.status === "loading" || t.pendingUrl) moving = true;
    if (t.status === "complete" && !t.pendingUrl && (moving || Date.now() - start > 1500)) return t;
    if (Date.now() - start > ms) return t;
    await nap(200);
  }
}

/** 点完、输完：看看是不是跳页了 */
async function after(before) {
  await nap(700);
  let t = await chrome.tabs.get(before.id);
  if (t.status === "loading" || t.pendingUrl) t = await waitLoad(before.id, 10000);
  const navigated = (t.url || "") !== (before.url || "");
  return { navigated, url: t.url || "", title: t.title || "" };
}

const OPS = {
  async tabs() {
    const all = await chrome.tabs.query({});
    return { tabs: all.filter((t) => !blocked(t.url || "")).map((t) => ({ id: t.id, title: t.title || "", url: t.url || "", active: !!t.active, windowId: t.windowId })) };
  },
  async peek(a) {
    const t = await pickTab(a.tab);
    return { id: t.id, url: t.url || t.pendingUrl || "", title: t.title || "", active: !!t.active };
  },
  async open(a) {
    const url = String(a.url || "");
    const why = blocked(url);
    if (why) throw oops("blocked", why);
    let t;
    if (a.tab != null) {
      const cur = await chrome.tabs.get(Number(a.tab));
      const w = blocked(cur.url || "");
      if (w) throw oops("blocked", w);
      t = await chrome.tabs.update(cur.id, { url });
    } else {
      t = await chrome.tabs.create({ url, active: true });
    }
    const done = await waitLoad(t.id, 25000);
    return { id: done.id, url: done.url || done.pendingUrl || url, title: done.title || "" };
  },
  async read(a) {
    const t = await guard(a);
    return inPage(t.id, "read", { maxChars: a.maxChars, expectOrigin: a.expectOrigin });
  },
  async resolve(a) {
    const t = await guard(a);
    return inPage(t.id, "resolve", { ref: a.ref, selector: a.selector, text: a.text, forType: !!a.forType, expectOrigin: a.expectOrigin });
  },
  async click(a) {
    const t = await guard(a);
    await inPage(t.id, "click", { ref: a.ref, expectOrigin: a.expectOrigin });
    return after(t);
  },
  async type(a) {
    const t = await guard(a);
    await inPage(t.id, "type", { ref: a.ref, text: a.text, clear: a.clear !== false, submit: !!a.submit, expectOrigin: a.expectOrigin });
    return after(t);
  },
  async scroll(a) {
    const t = await guard(a);
    return inPage(t.id, "scroll", { direction: a.direction, amount: a.amount, expectOrigin: a.expectOrigin });
  },
  /** 页面跳了也接着等：每半秒重新核一遍网站、找一遍 */
  async wait(a, id) {
    const end = Date.now() + Math.min(60000, Math.max(1000, Number(a.timeoutMs) || 10000));
    for (;;) {
      if (cancelled.has(id)) throw oops("stopped", "任务已经停了");
      const t = await guard(a);
      let found = false;
      if (t.status === "complete") {
        try { found = (await inPage(t.id, "find", { selector: a.selector, text: a.text, expectOrigin: a.expectOrigin })).found; }
        catch (e) { if (e.code === "moved" || /selector/.test(e.message)) throw e; }
      }
      if (found) return { found: true };
      if (Date.now() > end) return { found: false };
      await nap(500);
    }
  },
  /** 截屏只能截窗口里正在看的那个：先切过去，截完切回原来那个 */
  async shot(a) {
    const t = await guard(a);
    let back = null;
    if (!t.active) {
      [back] = await chrome.tabs.query({ active: true, windowId: t.windowId });
      await chrome.tabs.update(t.id, { active: true });
      await nap(350);
    }
    try {
      const again = await guard(a);
      return { dataUrl: await chrome.tabs.captureVisibleTab(again.windowId, { format: "jpeg", quality: 70 }) };
    } finally {
      if (back && back.id !== t.id) chrome.tabs.update(back.id, { active: true }).catch(() => {});
    }
  },
};

async function handleCall(m) {
  const id = String(m.id || "");
  const op = String(m.op || "");
  let res;
  try {
    if (!Object.prototype.hasOwnProperty.call(OPS, op)) throw oops("unknown", "扩展不认识这一步，更新一下扩展再试");
    res = { ok: true, data: await OPS[op](m.args && typeof m.args === "object" ? m.args : {}, id) };
  } catch (e) {
    res = { ok: false, code: (e && e.code) || "failed", error: human(e) };
  }
  cancelled.delete(id);
  send({ type: "result", id, ...res });
}

// ── 弹窗 ──

async function statusNow() {
  const s = await chrome.storage.local.get(["addr", "token", "owner"]);
  return {
    state, error: lastError, owner: String(s.owner || owner || ""), addr: normAddr(s.addr) || DEFAULT_ADDR,
    paired: !!s.token, version: chrome.runtime.getManifest().version,
  };
}

async function onPopup(msg) {
  if (msg.type === "status") return statusNow();
  if (msg.type === "pair") {
    const a = normAddr(msg.addr);
    if (!a) return { ok: false, error: "地址看不懂：要像 http://127.0.0.1:3800 这样" };
    const code = String(msg.code || "").toUpperCase().replace(/[^0-9A-Z]/g, "");
    if (code.length !== 8) return { ok: false, error: "配对码是 8 位，像 ABCD-EFGH" };
    await chrome.storage.local.set({ addr: a });
    parked = false;
    settlePair({ ok: false, error: "换了一次配对" });
    const got = new Promise((resolve) => {
      pairWaiter = resolve;
      setTimeout(() => settlePair({ ok: false, error: "等了 15 秒没回音：看看地址对不对、OpenWorkBuddy 开着没有" }), 15000);
    });
    lastError = "";
    if (ws) { const old = ws; ws = null; try { old.close(1000, "pair"); } catch {} }
    await connect(code);
    return got;
  }
  if (msg.type === "unpair") {
    await stopRecording(); recording = null;
    send({ type: "unpair" });
    await chrome.storage.local.remove(["token", "owner"]);
    owner = "";
    if (ws) { const old = ws; ws = null; stopTimers(); setTimeout(() => { try { old.close(1000, "unpair"); } catch {} }, 300); }
    setState("idle");
    return { ok: true };
  }
  if (msg.type === "reconnect") {
    backoff = 1000;
    parked = false;
    if (ws) { const old = ws; ws = null; try { old.close(1000, "again"); } catch {} }
    await connect();
    return statusNow();
  }
  return { ok: false };
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  // 只听自己的弹窗：网页里注入的东西不发这种消息
  if (!msg || typeof msg !== "object" || sender.id !== chrome.runtime.id || sender.tab) return false;
  onPopup(msg).then(reply, (e) => reply({ ok: false, error: human(e) }));
  return true;
});

importScripts("recording-background.js");

function keepAlive() {
  chrome.alarms.get(ALARM).then((a) => { if (!a) chrome.alarms.create(ALARM, { periodInMinutes: 0.5 }); }).catch(() => {});
}
chrome.alarms.onAlarm.addListener((a) => { if (a.name === ALARM && !ws && !parked) connect(); });
chrome.runtime.onInstalled.addListener(() => { keepAlive(); connect(); });
chrome.runtime.onStartup.addListener(() => { keepAlive(); connect(); });
keepAlive();
connect();
