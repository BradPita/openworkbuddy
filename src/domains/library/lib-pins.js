// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 OpenWorkBuddy Contributors · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 侧栏文件置顶：每个资料库根一份，只存来源、相对路径和不透明的工作区指纹，不落机器绝对路径。
 * 格式和收藏分开（.pins.json / .favorites.json）：收藏是资料整理视图，置顶是侧栏快捷入口。
 */
const fs = require("fs");
const path = require("path");
const store = require("../../platform/store");

const PIN_FILE = ".pins.json";
const PIN_MAX = 1000;
const SOURCES = new Set(["lib", "ws"]);
const chains = new Map();
const cache = new Map();

function pinFileOf(root) { return path.join(String(root || ""), PIN_FILE); }

/** Canonical key: "lib:relative/path" or "ws:relative/path". */
function pinKey(src, rel) {
  if (!SOURCES.has(String(src || ""))) return "";
  const text = String(rel || "").replace(/\\/g, "/");
  if (!text || text.length > 4096 || text.startsWith("/") || /^[a-zA-Z]:/.test(text) || /[\u0000-\u001f]/.test(text)) return "";
  const parts = text.split("/").filter((x) => x && x !== ".");
  if (!parts.length || parts.some((x) => x === "..")) return "";
  if (src === "lib" && parts.some((x) => x.startsWith(".") || /[<>:"|?*]/.test(x))) return "";
  return src + ":" + parts.join("/");
}

function splitPinKey(key) {
  const i = String(key || "").indexOf(":");
  if (i < 1) return null;
  const src = String(key).slice(0, i), rel = String(key).slice(i + 1);
  const clean = pinKey(src, rel);
  return clean ? { key: clean, src, path: clean.slice(i + 1) } : null;
}

const empty = () => ({ v: 2, items: {} });

function storedId(key, root) {
  const k = splitPinKey(key);
  const r = k && k.src === "ws" ? String(root || "") : "";
  if (r && !/^[a-f0-9]{8}$/i.test(r)) return "";
  return k ? k.key + (r ? "\u0000" + r.toLowerCase() : "") : "";
}

function storedParts(id) {
  const m = /\u0000([a-f0-9]{8})$/i.exec(String(id || ""));
  return { key: m ? String(id).slice(0, m.index) : String(id || ""), root: m ? m[1].toLowerCase() : "" };
}

/** Corrupt state is preserved under a .bad-* name; valid rows survive independently. */
function readPins(root) {
  const file = pinFileOf(root);
  let st;
  try { st = fs.statSync(file); } catch { cache.delete(file); return empty(); }
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.data;
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  if (!raw || ![1, 2].includes(raw.v) || !raw.items || typeof raw.items !== "object" || Array.isArray(raw.items)) {
    const bad = `${file}.bad-${Date.now()}`;
    try { fs.renameSync(file, bad); } catch {}
    cache.delete(file);
    return empty();
  }
  const items = {};
  for (const [key, value] of Object.entries(raw.items)) {
    const stored = storedParts(key);
    const k = splitPinKey(stored.key);
    if (!k || !value || typeof value !== "object") continue;
    const root = k.src === "ws" ? (String(value.root || stored.root || "").toLowerCase()) : "";
    if (root && !/^[a-f0-9]{8}$/.test(root)) continue;
    const id = storedId(k.key, root);
    if (!id) continue;
    items[id] = { at: Math.max(0, Number(value.at) || 0), ...(root ? { root } : {}) };
  }
  const data = { v: 2, items };
  cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, data });
  return data;
}

function serial(root, fn) {
  const key = path.resolve(String(root || ""));
  const prev = chains.get(key) || Promise.resolve();
  const job = prev.then(fn, fn);
  const tail = job.catch(() => {});
  chains.set(key, tail);
  tail.then(() => { if (chains.get(key) === tail) chains.delete(key); });
  return job;
}

async function setPin(root, key, on, now, workspaceRoot) {
  const k = splitPinKey(key);
  if (!k) throw Object.assign(new Error("文件路径不合法"), { status: 400 });
  const id = storedId(k.key, workspaceRoot);
  if (!id) throw Object.assign(new Error("工作区标识不合法"), { status: 400 });
  return serial(root, () => {
    const data = readPins(root);
    const items = { ...data.items };
    if (on) {
      if (!items[id] && Object.keys(items).length >= PIN_MAX) throw Object.assign(new Error(`侧栏最多置顶 ${PIN_MAX} 个文件`), { status: 400 });
      items[id] = { at: items[id] ? items[id].at : (Number(now) || Date.now()), ...(workspaceRoot && k.src === "ws" ? { root: String(workspaceRoot).toLowerCase() } : {}) };
    } else {
      if (!items[id]) return 0;
      delete items[id];
    }
    fs.mkdirSync(String(root), { recursive: true });
    store.writeJsonAtomic(pinFileOf(root), { v: 2, items }, { backup: false });
    cache.delete(pinFileOf(root));
    return on ? items[id].at : 0;
  });
}

/** exists(src,path) resolves through the requester's own roots; missing pins stay visible for cleanup. */
function listPins(root, exists) {
  const out = [];
  for (const [id, value] of Object.entries(readPins(root).items)) {
    const stored = storedParts(id);
    const k = splitPinKey(stored.key);
    if (!k) continue;
    const workspaceRoot = k.src === "ws" ? (value.root || stored.root || "") : "";
    let present = false, meta = null;
    try { meta = exists(k.src, k.path, workspaceRoot); present = !!meta; } catch {}
    out.push({ key: k.key, ...(workspaceRoot ? { root: workspaceRoot } : {}), src: k.src, path: k.path, name: path.posix.basename(k.path), pinned_at: value.at, missing: !present,
      ...(meta && Number.isFinite(meta.size) ? { size: meta.size } : {}),
      ...(meta && meta.mtime ? { mtime: meta.mtime instanceof Date ? meta.mtime.toISOString() : String(meta.mtime) } : {}) });
  }
  return out.sort((a, b) => (b.pinned_at - a.pinned_at) || a.key.localeCompare(b.key));
}

module.exports = { PIN_FILE, PIN_MAX, pinFileOf, pinKey, splitPinKey, readPins, setPin, listPins };
