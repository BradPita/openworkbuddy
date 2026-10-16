// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 OpenWorkBuddy Contributors · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 测试用的最小 WebSocket 客户端：握手自己拼、帧自己打掩码。
 *
 * 为什么不用 node 自带的 WebSocket：它不让填 Origin，而扩展那条线的头一道闸就是查 Origin；
 * 还要能发不合规的帧（不带掩码、超大、乱码）看服务端怎么断。
 *
 *   const c = await open(port, { origin: "chrome-extension://…" }); // c.status 是 HTTP 状态码，101 才有 c.ws
 *   c.ws.json({ type: "hello", token });
 *   const m = await c.ws.next((m) => m.type === "welcome");        // 等不到回 null，不抛
 *   const { code } = await c.ws.closed;
 *
 * browserSocket(origin) 照浏览器 WebSocket 的样子再包一层（readyState、onopen/onmessage/onclose），
 * 给 vm 里跑的扩展后台用；Origin 是浏览器填的，这里由调用方钉死。
 */
const net = require("net");
const crypto = require("crypto");
const { EventEmitter } = require("events");

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** 打一帧：默认带掩码（客户端本该如此），mask:false 用来试服务端拦不拦 */
function frame(op, payload, { mask = true, fin = true, rsv = 0 } = {}) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload == null ? "" : payload), "utf8");
  const len = body.length;
  let head;
  if (len < 126) { head = Buffer.alloc(2); head[1] = len; }
  else if (len < 65536) { head = Buffer.alloc(4); head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  head[0] = (fin ? 0x80 : 0) | ((rsv & 7) << 4) | op;
  if (!mask) return Buffer.concat([head, body]);
  head[1] |= 0x80;
  const key = crypto.randomBytes(4);
  const out = Buffer.from(body);
  for (let i = 0; i < len; i++) out[i] ^= key[i & 3];
  return Buffer.concat([head, key, out]);
}

class Client extends EventEmitter {
  constructor(socket, rest) {
    super();
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.queue = [];
    this.waiters = [];
    this.all = []; // 收到过的全部消息（JSON 解开的；不是 JSON 的给 { raw }）
    this.pongs = 0;
    this.closeInfo = null;
    this.sentClose = false;
    this.ended = false;
    this.closed = new Promise((r) => { this._resolveClosed = r; });
    socket.on("data", (d) => this._data(d));
    socket.on("close", () => this._end());
    socket.on("error", () => {});
    if (rest && rest.length) this._data(rest);
  }

  _data(d) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const op = b[0] & 0x0f;
      let len = b[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
      if (b.length < off + len) return;
      const payload = b.subarray(off, off + len);
      this.buf = b.subarray(off + len);
      if (op === 0x1) this._message(payload.toString("utf8"));
      else if (op === 0xa) { this.pongs++; this.emit("pong"); }
      else if (op === 0x8) {
        if (!this.closeInfo) {
          this.closeInfo = { code: payload.length >= 2 ? payload.readUInt16BE(0) : 1005, reason: payload.length > 2 ? payload.subarray(2).toString("utf8") : "" };
        }
        if (!this.sentClose) { this.sentClose = true; try { this.socket.write(frame(0x8, payload.subarray(0, 2))); } catch {} }
        try { this.socket.end(); } catch {}
      }
    }
  }

  _message(text) {
    let m;
    try { m = JSON.parse(text); } catch { m = { raw: text }; }
    this.all.push(m);
    this.emit("message", text);
    const i = this.waiters.findIndex((w) => w.pred(m));
    if (i >= 0) {
      const [w] = this.waiters.splice(i, 1);
      clearTimeout(w.timer);
      w.resolve(m);
    } else this.queue.push(m);
  }

  _end() {
    if (this.ended) return;
    this.ended = true;
    const info = this.closeInfo || { code: 1006, reason: "" };
    for (const w of this.waiters.splice(0)) { clearTimeout(w.timer); w.resolve(null); }
    this._resolveClosed(info);
    this.emit("close", info.code, info.reason);
  }

  /** 下一条满足 pred 的消息（先看已经收到没取走的）；ms 内等不到回 null */
  next(pred = () => true, ms = 3000) {
    const i = this.queue.findIndex(pred);
    if (i >= 0) return Promise.resolve(this.queue.splice(i, 1)[0]);
    if (this.ended) return Promise.resolve(null);
    return new Promise((resolve) => {
      const w = { pred, resolve, timer: setTimeout(() => { this.waiters.splice(this.waiters.indexOf(w), 1); resolve(null); }, ms) };
      this.waiters.push(w);
    });
  }

  text(s) { if (!this.ended) this.socket.write(frame(0x1, String(s))); }
  json(o) { this.text(JSON.stringify(o)); }
  raw(buf) { if (!this.ended) this.socket.write(buf); }
  ping(payload = "") { this.raw(frame(0x9, payload)); }
  close(code = 1000, reason = "") {
    if (this.sentClose || this.ended) return;
    this.sentClose = true;
    const r = Buffer.from(String(reason), "utf8");
    const p = Buffer.alloc(2 + r.length);
    p.writeUInt16BE(code, 0);
    r.copy(p, 2);
    try { this.socket.write(frame(0x8, p)); } catch {}
  }
  /** 不打招呼直接掐线（模拟断网、Chrome 被杀） */
  drop() { try { this.socket.destroy(); } catch {} }
}

/**
 * @returns {Promise<{status:number, head?:string, ws:Client|null}>} status 0 = 没回 HTTP 就断了；-1 = 回了 101 但 Accept 对不上
 */
function open(port, opts = {}) {
  const { path: p = "/browser-link/ws", origin = "", host = `127.0.0.1:${port}`, version = "13", extra = "" } = opts;
  const key = opts.key || crypto.randomBytes(16).toString("base64");
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port });
    let buf = Buffer.alloc(0);
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    s.on("error", () => finish({ status: 0, ws: null }));
    s.on("close", () => finish({ status: 0, ws: null }));
    s.on("connect", () => {
      s.write(
        `GET ${p} HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: ${version}\r\n` +
          (origin ? `Origin: ${origin}\r\n` : "") + extra + "\r\n"
      );
    });
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      const i = buf.indexOf("\r\n\r\n");
      if (i < 0) return;
      s.removeListener("data", onData);
      const head = buf.subarray(0, i).toString("latin1");
      const status = Number((/^HTTP\/1\.1 (\d{3})/.exec(head) || [])[1] || 0);
      if (status !== 101) { s.destroy(); return finish({ status, head, ws: null }); }
      const accept = (/^sec-websocket-accept:\s*(\S+)/im.exec(head) || [])[1];
      if (accept !== crypto.createHash("sha1").update(key + GUID).digest("base64")) { s.destroy(); return finish({ status: -1, head, ws: null }); }
      finish({ status, head, ws: new Client(s, buf.subarray(i + 4)) });
    };
    s.on("data", onData);
  });
}

/** 浏览器那种 WebSocket（只做扩展后台用到的那几样）；每建一个记进 made，测试数得出它连了几回 */
function browserSocket(origin) {
  const made = [];
  class WebSocket {
    constructor(url) {
      const u = new URL(url);
      if (u.protocol !== "ws:" && u.protocol !== "wss:") throw new SyntaxError("bad url");
      this.url = url;
      this.readyState = 0;
      this.onopen = this.onmessage = this.onclose = this.onerror = null;
      this._ws = null;
      this._closeAsked = null;
      made.push(this);
      open(Number(u.port || 80), { path: u.pathname + u.search, origin, host: u.host }).then((r) => {
        if (!r.ws) {
          this.readyState = 3;
          if (this.onerror) this.onerror({ type: "error" });
          if (this.onclose) this.onclose({ code: 1006, reason: "" });
          return;
        }
        this._ws = r.ws;
        r.ws.on("message", (t) => { if (this.onmessage) this.onmessage({ data: t }); });
        r.ws.closed.then(({ code, reason }) => { this.readyState = 3; if (this.onclose) this.onclose({ code, reason }); });
        if (this._closeAsked) { this.readyState = 2; r.ws.close(...this._closeAsked); return; }
        this.readyState = 1;
        if (this.onopen) this.onopen({ type: "open" });
      });
    }
    send(t) {
      if (this.readyState !== 1) throw new Error("InvalidStateError");
      this._ws.text(String(t));
    }
    close(code = 1000, reason = "") {
      if (this.readyState >= 2) return;
      if (!this._ws) { this._closeAsked = [code, reason]; return; }
      this.readyState = 2;
      this._ws.close(code, reason);
    }
  }
  return { WebSocket, made };
}

module.exports = { open, frame, browserSocket };
