// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 OpenWorkBuddy Contributors
"use strict";
const crypto = require("crypto");
const fs = require("fs");
const store = require("../../platform/store");
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const SID = /^[\w-]{1,80}$/;
const hash = (s) => crypto.createHash("sha256").update(s).digest("hex");

/** Private, atomic storage. Revoked links must never be recovered from an older backup. */
function createShareStore(file) {
  function read() {
    const data = store.readJson(file, { version: 1, items: {} }, { strict: true });
    if (!data || data.version !== 1 || !data.items || typeof data.items !== "object" || Array.isArray(data.items)) throw new Error("分享记录损坏，请检查数据文件");
    return data;
  }
  const write = (data) => store.writeJsonAtomic(file, data, { mode: 0o600, backup: false });
  const valid = (r) => r && TOKEN.test(r.token) && SID.test(r.sid) && typeof r.owner === "string" && typeof r.org === "string";
  function find(sid, owner, org) { return Object.values(read().items).find((r) => valid(r) && r.sid === sid && r.owner === owner && r.org === org) || null; }
  return {
    find,
    create(sid, owner, org) {
      if (!SID.test(sid) || !owner || !org) throw new Error("任务归属不完整，不能分享");
      const data = read();
      const old = Object.values(data.items).find((r) => valid(r) && r.sid === sid && r.owner === owner && r.org === org);
      if (old) return { ...old };
      if (Object.keys(data.items).length >= 5000) throw new Error("分享链接过多，请先撤回不再需要的链接");
      const row = { token: crypto.randomBytes(32).toString("base64url"), sid, owner, org, created_at: Date.now() };
      data.items[hash(row.token)] = row; write(data); return { ...row };
    },
    get(token) {
      if (typeof token !== "string" || !TOKEN.test(token)) return null;
      const row = read().items[hash(token)];
      return valid(row) && row.token === token ? { ...row } : null;
    },
    revoke(sid, owner, org) {
      const data = read(); let changed = false;
      for (const [key, r] of Object.entries(data.items)) if (r.sid === sid && r.owner === owner && r.org === org) { delete data.items[key]; changed = true; }
      if (changed) write(data);
      return changed;
    },
    count() { return Object.keys(read().items).length; },
  };
}
/** Relative delivered paths, in event order, excluding deleted outputs. */
function deliveredPaths(session) {
  const files = new Set();
  const safe = (p) => typeof p === "string" && p.length < 2048 && !p.includes("\0") && !/^[\\/]|^[A-Za-z]:/.test(p) && !p.replace(/\\/g, "/").split("/").some((x) => x === ".." || x === "." || !x);
  for (const turn of session.transcript || []) for (const event of turn.events || []) if (event.type === "files") {
    for (const p of Array.isArray(event.changed) ? event.changed : []) if (safe(p)) files.add(p.replace(/\\/g, "/"));
    for (const p of Array.isArray(event.gone) ? event.gone : []) if (safe(p)) files.delete(p.replace(/\\/g, "/"));
  }
  return [...files].slice(0, 2000);
}
function resolveDelivered(session, name, allowed = new Set(deliveredPaths(session))) {
  if (!session.root || !allowed.has(name)) return null;
  try {
    const path = require("path");
    const root = fs.realpathSync(session.root), file = fs.realpathSync(path.join(root, name));
    const rel = path.relative(root, file);
    if (!rel || rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) return null;
    const stat = fs.statSync(file);
    return stat.isFile() ? { file, stat } : null;
  } catch { return null; }
}
/** User-facing conversation only: tool parameters, traces, tokens and absolute roots stay private. */
function publicTask(session, clean = (s) => s) {
  const turns = [];
  for (const turn of session.transcript || []) {
    if (turn.type === "user") turns.push({ role: "user", text: clean(String(turn.shown || turn.text || "")), at: turn.at || "" });
    else if (turn.type === "assistant") {
      const text = (turn.events || []).filter((e) => e.type === "text").map((e) => e.delta || "").join("");
      if (text) turns.push({ role: "assistant", text: clean(text), at: turn.at || "" });
    }
  }
  const allowed = new Set(deliveredPaths(session));
  const files = [...allowed].flatMap((p) => { const r = resolveDelivered(session, p, allowed); return r ? [{ path: p, size: r.stat.size }] : []; });
  return { title: clean(String(session.title || "任务")), turns, files };
}
module.exports = { createShareStore, publicTask, deliveredPaths, resolveDelivered, TOKEN, SID };
