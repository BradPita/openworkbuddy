// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 OpenWorkBuddy Contributors · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 最小的 WebSocket 服务端（RFC 6455），只给浏览器扩展那条线用。
 *
 * 为什么自己写：依赖树里那份 ws 是别的包顺带装的，版本不归我们管，哪天上游一换就没了；
 * 这条线只走文本 JSON + ping/pong + close，一百多行就够，只靠 node 自带的 crypto。
 *   - 客户端帧必须带掩码（规范要求），不带的当场 1002 断开
 *   - 一条消息最多 16MB（截图走这条线回来，JPEG 一般几百 KB）
 *   - 不协商任何扩展（permessage-deflate 一律不接），RSV 位不为 0 就断
 */
const crypto = require("crypto");
const { EventEmitter } = require("events");

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_MESSAGE = 16 * 1024 * 1024;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

/** @param {string} key 客户端的 Sec-WebSocket-Key */
function acceptKey(key) {
  return crypto.createHash("sha1").update(String(key) + GUID).digest("base64");
}

/** 握手前就不收的：回一个 HTTP 状态码再关 */
function reject(socket, status, text) {
  try { socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch {}
  const t = setTimeout(() => { try { socket.destroy(); } catch {} }, 1000);
  if (t.unref) t.unref();
}

/** reason 按字节截到 123 以内，不切坏多字节字符 */
function closeReason(s) {
  let r = String(s || "");
  while (Buffer.byteLength(r, "utf8") > 123) r = r.slice(0, -1);
  return Buffer.from(r, "utf8");
}

class WsConn extends EventEmitter {
  constructor(socket, { maxMessage = MAX_MESSAGE } = {}) {
    super();
    this.socket = socket;
    this.maxMessage = maxMessage;
    this.chunks = [];
    this.size = 0;
    this.need = 2; // 下一次解析前至少要攒够多少字节：大消息一块块来时只拼一次，不每块都整份复制
    this.frags = null;
    this.closed = false;
    this.lastSeen = Date.now();
    socket.on("data", (d) => this._onData(d));
    socket.on("close", () => this._gone(1006, ""));
    socket.on("error", () => this._gone(1006, ""));
    // http.Server 交过来的套接字是半开的：对方掐线（Chrome 被杀、断网）只来一个 end，不收尾就一直挂着「已连上」
    socket.on("end", () => { this._gone(1006, ""); try { socket.destroy(); } catch {} });
  }

  _onData(d) {
    if (this.closed) return;
    this.lastSeen = Date.now();
    this.chunks.push(d);
    this.size += d.length;
    if (this.size < this.need) return;
    let buf = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.size);
    for (;;) {
      const f = this._frame(buf);
      if (this.closed) return;
      if (!f) break;
      buf = buf.subarray(f.used);
      this._handle(f);
      if (this.closed) return;
    }
    this.chunks = buf.length ? [buf] : [];
    this.size = buf.length;
  }

  /** 从 buf 开头解出一帧；不够一帧返回 null 并记下还差多少 */
  _frame(b) {
    this.need = 2;
    if (b.length < 2) return null;
    const fin = (b[0] & 0x80) !== 0;
    const op = b[0] & 0x0f;
    if (b[0] & 0x70) return this._fail(1002, "rsv");
    if (!(b[1] & 0x80)) return this._fail(1002, "unmasked");
    let len = b[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (b.length < 4) { this.need = 4; return null; }
      len = b.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      if (b.length < 10) { this.need = 10; return null; }
      const big = b.readBigUInt64BE(2);
      if (big > BigInt(this.maxMessage)) return this._fail(1009, "too big");
      len = Number(big);
      off = 10;
    }
    if (op >= 8 && (!fin || len > 125)) return this._fail(1002, "bad control frame");
    if (len > this.maxMessage) return this._fail(1009, "too big");
    const total = off + 4 + len;
    if (b.length < total) { this.need = total; return null; }
    const mask = b.subarray(off, off + 4);
    const payload = Buffer.from(b.subarray(off + 4, total));
    for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];
    return { fin, op, payload, used: total };
  }

  _handle({ fin, op, payload }) {
    if (op === 0x8) {
      if (payload.length === 1) return this._fail(1002, "bad close");
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1000;
      const echo = code >= 1000 && code < 5000 && ![1004, 1005, 1006, 1015].includes(code) ? code : 1000;
      return this.close(echo, "");
    }
    if (op === 0x9) return this._send(0xa, payload);
    if (op === 0xa) return;
    if (op === 0x0) {
      if (!this.frags) return this._fail(1002, "orphan continuation");
      this.frags.parts.push(payload);
      this.frags.size += payload.length;
      if (this.frags.size > this.maxMessage) return this._fail(1009, "too big");
      if (!fin) return;
      const { op: first, parts } = this.frags;
      this.frags = null;
      return this._message(first, Buffer.concat(parts));
    }
    if (op === 0x1 || op === 0x2) {
      if (this.frags) return this._fail(1002, "interleaved message");
      if (!fin) { this.frags = { op, parts: [payload], size: payload.length }; return; }
      return this._message(op, payload);
    }
    return this._fail(1002, "unknown opcode");
  }

  _message(op, payload) {
    if (op === 0x2) return this._fail(1003, "text only");
    let text;
    try { text = UTF8.decode(payload); } catch { return this._fail(1007, "bad utf-8"); }
    this.emit("message", text);
  }

  _fail(code, reason) {
    this.close(code, reason);
    return null;
  }

  _send(op, payload) {
    const len = payload.length;
    let head;
    if (len < 126) { head = Buffer.alloc(2); head[1] = len; }
    else if (len < 65536) { head = Buffer.alloc(4); head[1] = 126; head.writeUInt16BE(len, 2); }
    else { head = Buffer.alloc(10); head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
    head[0] = 0x80 | op;
    if (this.socket.destroyed || !this.socket.writable) return false;
    try { this.socket.write(Buffer.concat([head, payload])); return true; } catch { return false; }
  }

  /** @param {string} text */
  send(text) {
    if (this.closed) return false;
    return this._send(0x1, Buffer.from(String(text), "utf8"));
  }

  close(code = 1000, reason = "") {
    if (this.closed) return;
    const r = closeReason(reason);
    const p = Buffer.alloc(2 + r.length);
    p.writeUInt16BE(code, 0);
    r.copy(p, 2);
    this._send(0x8, p);
    this._gone(code, String(reason || ""));
    try { this.socket.end(); } catch {}
    // 对方不回 close 也别一直挂着
    const t = setTimeout(() => { try { this.socket.destroy(); } catch {} }, 1000);
    if (t.unref) t.unref();
  }

  _gone(code, reason) {
    if (this.closed) return;
    this.closed = true;
    this.emit("close", code, reason);
  }
}

/**
 * 接一次 HTTP upgrade。握手不合规就回 400 并返回 null。
 * @returns {WsConn|null}
 */
function handleUpgrade(req, socket, head, { maxMessage } = {}) {
  const key = String(req.headers["sec-websocket-key"] || "");
  const upg = String(req.headers.upgrade || "").toLowerCase();
  if (req.method !== "GET" || upg !== "websocket" || !/^[A-Za-z0-9+/]{22}==$/.test(key) || String(req.headers["sec-websocket-version"]) !== "13") {
    reject(socket, 400, "Bad Request");
    return null;
  }
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`
  );
  if (socket.setNoDelay) socket.setNoDelay(true);
  const conn = new WsConn(socket, { maxMessage });
  if (head && head.length) conn._onData(head);
  return conn;
}

module.exports = { handleUpgrade, reject, acceptKey, WsConn, MAX_MESSAGE };
