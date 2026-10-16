// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 OpenWorkBuddy Contributors · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 用户自己那个 Chrome 跟这台 OpenWorkBuddy 之间的那条线。
 *
 * 扩展（extension/chrome/）在用户的 Chrome 里开一条 WebSocket 连到 /browser-link/ws：
 *   - 头一回拿设置页给的配对码换一个长期令牌。令牌只存在扩展里，这边只记它的 sha256；
 *     配对码十分钟内有效、用一次就作废，试错多了整个口子歇十分钟
 *   - 以后每次连上先报令牌，对上了才算是这个人的 Chrome
 *   - 只认 chrome-extension:// 来的连接：网页里的脚本连不进来（Origin 是浏览器填的，页面改不了）；
 *     配对时还把扩展 ID 钉住，令牌被别的扩展拿去也用不了
 *   - 一个账号只配一个 Chrome，重新配对旧的立刻作废、断线
 *
 * 任务要动浏览器只能找它主人配的那个（call(owner, …)）：找不到就说没连上，绝不借别人的。
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { dataPath, appPath } = require("../../platform/paths");
const wsServer = require("../../platform/ws-server");

const WS_PATH = "/browser-link/ws";
const ORIGIN_RE = /^chrome-extension:\/\/[a-p]{32}$/;
const CODE_ABC = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"; // 去掉了 0/O、1/I/L：抄错一个字就得重来
const CODE_TTL_MS = 10 * 60 * 1000;
const HELLO_MS = 5000;
const IDLE_MS = 60 * 1000; // 扩展 20 秒一次心跳，一分钟没动静就当它没了
const FAIL_WINDOW_MS = 10 * 60 * 1000;
const FAIL_PER_IP = 20;
const FAIL_ALL = 200;
const PRE_AUTH_MAX = 8 * 1024; // 认出是谁之前，一条消息最多这么大
const OFFLINE = "你的 Chrome 现在没连上：打开 Chrome，确认 OpenWorkBuddy 扩展开着";
const BAD_CODE = "配对码不对或者过期了，回设置页重新生成一个";
const BAD_TOKEN = "配对失效了，回设置页重新配对";
const TOO_MANY = "试错太多次了，过十分钟再试";

let dir = dataPath("data", "chrome-link");
/** @type {Map<string, {owner:string,id:string,hash:string,name:string,ext_origin:string,created_at:string,last_seen:string}>|null} */
let devices = null;
const codes = new Map(); // 规整后的配对码 -> { owner, exp }
const live = new Map(); // owner -> { conn, owner, version, since, pending: Map<id, done> }
const fails = []; // [{ ip, ts }]，按时间排
const hosts = new Set(); // 扩展连上来时用的地址（Host 头）：工具层拿它拦「让 Chrome 打开 OWB 自己」
let attachedTo = null;
let sweeper = null;
let seq = 0;
let bundled = null;

const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const nowIso = () => new Date().toISOString();
const fileOf = () => path.join(dir, "devices.json");
const normCode = (s) => String(s || "").toUpperCase().replace(/[^0-9A-Z]/g, "");
const cleanName = (s) => String(s || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 60) || "Chrome";
const cleanVersion = (s) => (/^\d{1,5}(\.\d{1,5}){0,3}$/.test(String(s || "")) ? String(s) : "");

function loadDevices() {
  if (devices) return devices;
  devices = new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(fileOf(), "utf8"));
    for (const r of Array.isArray(raw && raw.devices) ? raw.devices : []) {
      if (!r || typeof r.owner !== "string" || !r.owner) continue;
      if (!/^[0-9a-f]{64}$/.test(String(r.hash || "")) || !ORIGIN_RE.test(String(r.ext_origin || ""))) continue;
      devices.set(r.owner, {
        owner: r.owner, id: String(r.id || ""), hash: r.hash, name: cleanName(r.name), ext_origin: r.ext_origin,
        created_at: String(r.created_at || ""), last_seen: String(r.last_seen || ""),
      });
    }
  } catch {}
  return devices;
}

/** 整份重写：先写临时文件再改名，写到一半断电也不会留下半截 JSON；只有本人能读 */
function saveDevices() {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = fileOf() + "." + process.pid + "." + crypto.randomBytes(4).toString("hex") + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({ devices: [...loadDevices().values()] }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, fileOf());
}

function failsFrom(ip) {
  const now = Date.now();
  while (fails.length && now - fails[0].ts > FAIL_WINDOW_MS) fails.shift();
  let mine = 0;
  for (const f of fails) if (f.ip === ip) mine++;
  return mine >= FAIL_PER_IP || fails.length >= FAIL_ALL;
}
function noteFail(ip) {
  fails.push({ ip, ts: Date.now() });
  if (fails.length > FAIL_ALL * 2) fails.shift();
}

/** 只比哈希：令牌原文不落盘；逐个用定长比较，别让比较快慢泄露出哪一位对上了 */
function deviceByToken(token) {
  if (!/^owbc_[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  const h = Buffer.from(sha256(token), "hex");
  for (const rec of loadDevices().values()) {
    const mine = Buffer.from(rec.hash, "hex");
    if (mine.length === h.length && crypto.timingSafeEqual(mine, h)) return rec;
  }
  return null;
}

/** 给这个人发一个新配对码；他之前没用掉的那个作废 */
function newPairCode(owner) {
  const who = String(owner || "");
  if (!who) throw new Error("没登录，生成不了配对码");
  const now = Date.now();
  for (const [c, e] of codes) if (e.owner === who || e.exp <= now) codes.delete(c);
  let raw;
  do {
    raw = "";
    for (let i = 0; i < 8; i++) raw += CODE_ABC[crypto.randomInt(CODE_ABC.length)];
  } while (codes.has(raw));
  const exp = now + CODE_TTL_MS;
  codes.set(raw, { owner: who, exp });
  return { code: raw.slice(0, 4) + "-" + raw.slice(4), expires_at: new Date(exp).toISOString() };
}

function linkOf(owner) {
  const link = live.get(String(owner || ""));
  return link && !link.conn.closed ? link : null;
}
const paired = (owner) => !!owner && loadDevices().has(String(owner));
const connected = (owner) => paired(owner) && !!linkOf(owner);

function bundledVersion() {
  if (bundled == null) {
    try { bundled = String(JSON.parse(fs.readFileSync(appPath("extension", "chrome", "manifest.json"), "utf8")).version || ""); } catch { bundled = ""; }
  }
  return bundled;
}

function status(owner) {
  const who = String(owner || "");
  const rec = who ? loadDevices().get(who) : null;
  const link = rec ? linkOf(who) : null;
  return {
    paired: !!rec,
    connected: !!link,
    name: rec ? rec.name : "",
    version: link ? link.version : "",
    bundled_version: bundledVersion(),
    last_seen: link ? nowIso() : rec ? rec.last_seen : "",
    since: link ? new Date(link.since).toISOString() : "",
  };
}

/** 连接没了：还在等它回话的那几步当场收尾，不让任务干等到超时 */
function gone(link, why) {
  if (live.get(link.owner) === link) live.delete(link.owner);
  for (const done of [...link.pending.values()]) done({ ok: false, code: "gone", error: why || "Chrome 那边断线了，这一步没做完" });
  link.pending.clear();
}

/** 解除配对：令牌作废、在线的那条当场断开（扩展收到会清掉自己存的令牌） */
function disconnect(owner) {
  const who = String(owner || "");
  if (!who) return { ok: false };
  for (const [c, e] of codes) if (e.owner === who) codes.delete(c);
  const had = loadDevices().delete(who);
  if (had) saveDevices();
  const link = live.get(who);
  if (link) {
    gone(link, "你在设置里断开了 Chrome");
    link.conn.send(JSON.stringify({ type: "unpaired" }));
    link.conn.close(4002, "unpaired");
  }
  return { ok: true, had };
}

/**
 * 让这个人的 Chrome 做一步。从不抛错，总是回 { ok, data } 或 { ok:false, code, error }。
 * 只找 owner 自己配的那个：没连上就是没连上，不看别人的。
 */
function call(owner, op, args = {}, { timeoutMs = 30000, stopSignal = null } = {}) {
  const who = String(owner || "");
  const link = who && paired(who) ? linkOf(who) : null;
  if (!link) return Promise.resolve({ ok: false, code: "offline", error: OFFLINE });
  if (stopSignal && stopSignal.aborted) return Promise.resolve({ ok: false, code: "stopped", error: "任务已经停了" });
  const id = "c" + ++seq;
  return new Promise((resolve) => {
    const done = (r) => {
      if (!link.pending.has(id)) return;
      link.pending.delete(id);
      clearTimeout(timer);
      if (stopSignal) stopSignal.removeEventListener("abort", onAbort);
      resolve(r);
    };
    const timer = setTimeout(() => done({ ok: false, code: "timeout", error: `Chrome 那边 ${Math.round(timeoutMs / 1000)} 秒没回话，这一步没做完` }), timeoutMs);
    const onAbort = () => {
      done({ ok: false, code: "stopped", error: "任务已经停了" });
      link.conn.send(JSON.stringify({ type: "cancel", id }));
    };
    if (stopSignal) stopSignal.addEventListener("abort", onAbort);
    link.pending.set(id, done);
    if (!link.conn.send(JSON.stringify({ type: "call", id, op: String(op), args: args || {} }))) done({ ok: false, code: "gone", error: OFFLINE });
  });
}

function register(conn, owner, version, host) {
  const old = live.get(owner);
  if (old && old.conn !== conn) {
    gone(old, "换了一个 Chrome 连上来");
    old.conn.close(4001, "replaced");
  }
  conn.maxMessage = wsServer.MAX_MESSAGE; // 认出是谁了才放开大小：截图走这条线回来
  const link = { conn, owner, version: cleanVersion(version), since: Date.now(), pending: new Map() };
  live.set(owner, link);
  if (host) hosts.add(host);
  return link;
}

function onUpgrade(req, socket, head) {
  let pathname = "";
  try { pathname = new URL(req.url || "/", "http://x").pathname; } catch {}
  if (pathname !== WS_PATH) {
    // 这个口上只有我们接 upgrade：不认识的路径直接挂掉，别让连接吊着
    if (attachedTo && attachedTo.listenerCount("upgrade") <= 1) socket.destroy();
    return;
  }
  const origin = String(req.headers.origin || "");
  if (!ORIGIN_RE.test(origin)) return wsServer.reject(socket, 403, "Forbidden");
  const ip = String((req.socket && req.socket.remoteAddress) || "");
  if (failsFrom(ip)) return wsServer.reject(socket, 429, "Too Many Requests");
  const conn = wsServer.handleUpgrade(req, socket, head, { maxMessage: PRE_AUTH_MAX });
  if (!conn) return;
  const host = String(req.headers.host || "").toLowerCase().slice(0, 200);
  const reply = (o) => conn.send(JSON.stringify(o));
  let link = null;
  const helloTimer = setTimeout(() => { if (!link) conn.close(4400, "hello timeout"); }, HELLO_MS);
  if (helloTimer.unref) helloTimer.unref();
  conn.on("close", () => {
    clearTimeout(helloTimer);
    if (link) gone(link);
  });
  const refuse = (code, message, wsCode) => {
    noteFail(ip);
    reply({ type: "error", code, message: failsFrom(ip) ? TOO_MANY : message });
    conn.close(wsCode, code);
  };
  conn.on("message", (text) => {
    let msg;
    try { msg = JSON.parse(text); } catch { return conn.close(4400, "bad json"); }
    if (!msg || typeof msg !== "object") return conn.close(4400, "bad message");
    if (!link) {
      clearTimeout(helloTimer);
      if (msg.type === "pair") {
        const code = normCode(msg.code);
        const e = codes.get(code);
        if (!e || e.exp <= Date.now()) return refuse("bad_code", BAD_CODE, 4403);
        codes.delete(code);
        const token = "owbc_" + crypto.randomBytes(32).toString("base64url");
        const prev = loadDevices().get(e.owner);
        const rec = { owner: e.owner, id: crypto.randomBytes(6).toString("hex"), hash: sha256(token), name: cleanName(msg.name), ext_origin: origin, created_at: nowIso(), last_seen: nowIso() };
        loadDevices().set(e.owner, rec);
        try { saveDevices(); } catch {
          if (prev) loadDevices().set(e.owner, prev); else loadDevices().delete(e.owner);
          reply({ type: "error", code: "save_failed", message: "这台机器存不下配对信息，看看磁盘是不是满了" });
          return conn.close(4500, "save failed");
        }
        link = register(conn, rec.owner, msg.version, host);
        return reply({ type: "paired", token, owner: rec.owner });
      }
      if (msg.type === "hello") {
        const rec = deviceByToken(String(msg.token || ""));
        if (!rec || rec.ext_origin !== origin) return refuse("bad_token", BAD_TOKEN, 4401);
        rec.last_seen = nowIso();
        try { saveDevices(); } catch {}
        link = register(conn, rec.owner, msg.version, host);
        return reply({ type: "welcome", owner: rec.owner });
      }
      return conn.close(4400, "hello first");
    }
    if (msg.type === "ping") return reply({ type: "pong" });
    if (msg.type === "unpair") return void disconnect(link.owner); // 用户在扩展里点了「断开」
    if (msg.type === "result") {
      const done = link.pending.get(String(msg.id || ""));
      if (done) done(msg.ok === true ? { ok: true, data: msg.data } : { ok: false, code: String(msg.code || "failed"), error: String(msg.error || "Chrome 那边没做成") });
    }
  });
}

function sweep() {
  const now = Date.now();
  for (const link of [...live.values()]) if (now - link.conn.lastSeen > IDLE_MS) link.conn.close(4408, "idle");
  for (const [c, e] of codes) if (e.exp <= now) codes.delete(c);
}

/** 挂到 HTTP 服务上；返回摘下来的函数 */
function attach(server) {
  if (attachedTo && attachedTo !== server) detach();
  if (!attachedTo) {
    attachedTo = server;
    server.on("upgrade", onUpgrade);
    sweeper = setInterval(sweep, 15000);
    if (sweeper.unref) sweeper.unref();
  }
  return detach;
}
function detach() {
  if (!attachedTo) return;
  attachedTo.removeListener("upgrade", onUpgrade);
  attachedTo = null;
  clearInterval(sweeper);
  sweeper = null;
  for (const link of [...live.values()]) {
    gone(link, "OpenWorkBuddy 关了");
    link.conn.close(1001, "server stop");
  }
}
/** 这个进程里有没有接扩展的口子：CLI、测试里没有，工具就不摆出来 */
const serving = () => !!attachedTo;

const LOOP = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
/** 这个网址是不是 OWB 自己（扩展连上来时用的那个地址；本机的几种写法算一个） */
function isOwnUrl(url) {
  let u;
  try { u = new URL(String(url)); } catch { return false; }
  const h = u.hostname.toLowerCase();
  const port = u.port || (u.protocol === "https:" ? "443" : "80");
  for (const hp of hosts) {
    let o;
    try { o = new URL("http://" + hp); } catch { continue; }
    const oh = o.hostname.toLowerCase();
    if (!o.port) { if (oh === h) return true; continue; } // 反向代理后面：Host 头不带端口，按域名算
    if (o.port === port && (oh === h || (LOOP.has(oh) && LOOP.has(h)))) return true;
  }
  return false;
}

/** 测试用：清空内存里的一切，可换存放目录 */
function _reset({ dir: d } = {}) {
  detach();
  for (const link of [...live.values()]) gone(link);
  live.clear();
  codes.clear();
  fails.length = 0;
  hosts.clear();
  devices = null;
  bundled = null;
  if (d) dir = d;
}

module.exports = {
  WS_PATH, ORIGIN_RE, OFFLINE,
  attach, detach, serving, paired, connected, status, disconnect, newPairCode, call, isOwnUrl, bundledVersion,
  _reset, _normCode: normCode,
};
