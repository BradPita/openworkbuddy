// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 OpenWorkBuddy Contributors
"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const checkpoints = require("./checkpoints");
const { readObject, readLedger, insideRoot, diffLines } = checkpoints._internals;
const hash = b => crypto.createHash("sha256").update(b).digest("hex");
function fail(message, status = 409) { throw Object.assign(new Error(message), { status }); }
function fenced(root, rel) {
  const abs = insideRoot(root, rel); if (!abs) fail("文件路径不在工作目录里", 400);
  const realRoot = fs.realpathSync(root);
  // Existing parents and the history directory must never escape through symlinks.
  for (const target of [abs, path.join(root, ".history"), path.join(root, ".history", "objects"), path.join(root, ".history", "checkpoints.jsonl")]) {
    let p = target; while (!fs.existsSync(p) && p !== path.dirname(p)) p = path.dirname(p);
    const real = fs.realpathSync(p); if (real !== realRoot && !real.startsWith(realRoot + path.sep)) fail("文件路径包含指向工作目录外的链接", 400);
  }
  return abs;
}
function textOf(buffer) {
  if (buffer == null) return "";
  if (buffer.length > 1024 * 1024 || buffer.includes(0)) fail("该文件不支持按块审查", 400);
  const text = buffer.toString("utf8"); if (!Buffer.from(text).equals(buffer)) fail("该文件不是 UTF-8 文本", 400); return text;
}
const lines = text => text.match(/[^\n]*\n|[^\n]+$/g) || [];
function load(root, session, id) {
  fenced(root, "review-placeholder");
  const ledger = readLedger(root), entry = ledger.find(e => e.id === id && e.session === session);
  if (!entry || entry.review) fail("没有这个文件检查点", 404);
  const abs = fenced(root, entry.rel), before = entry.before ? readObject(root, entry.before) : null, after = entry.after ? readObject(root, entry.after) : null;
  if (entry.before && !before || entry.after && !after) fail("检查点内容已缺失或损坏", 404);
  const a = lines(textOf(before)), b = lines(textOf(after));
  if (a.length + b.length > 20000) fail("文件行数过多，请使用整步回退", 400);
  const ops = diffLines(a, b), hunks = []; let oldLine = 1, newLine = 1, current = null;
  for (const [op, text] of ops) {
    if (op === " ") { current = null; oldLine++; newLine++; continue; }
    if (!current) { current = { id: "", old_line: oldLine, new_line: newLine, removed: [], added: [] }; hunks.push(current); }
    if (op === "-") { current.removed.push(text); oldLine++; } else { current.added.push(text); newLine++; }
  }
  hunks.forEach((h, i) => { h.id = hash(id + ":" + i + ":" + h.removed.join("") + "\0" + h.added.join("")).slice(0, 32); h.reverted = false; });
  for (const row of ledger) if (row.session === session && row.review?.origin === id) { const h = hunks.find(h => h.id === row.review.hunk); if (h) h.reverted = row.review.reverted === true; }
  const build = () => { const result = [...b]; for (const h of [...hunks].reverse()) if (h.reverted) result.splice(h.new_line - 1, h.added.length, ...h.removed); return result.join(""); };
  let disk = null; try { disk = fs.readFileSync(abs); } catch(e) { if (e.code !== "ENOENT") throw e; }
  const expected = build(), exists = entry.after == null ? hunks.some(h => h.reverted && h.removed.length) : !(entry.before == null && hunks.every(h => h.reverted));
  const matches = exists ? disk != null && disk.equals(Buffer.from(expected)) : disk == null;
  return { entry, hunks, abs, disk, expected, matches, build, hash: disk == null ? "missing" : hash(disk) };
}
function review(root, session, id) {
  const state = load(root, session, id);
  return { id, path: state.entry.rel, hash: state.hash, current: state.matches, hunks: state.hunks };
}
function revert(root, session, id, hunkId, expectedHash) {
  const state = load(root, session, id);
  if (!state.matches || state.hash !== expectedHash) fail("文件已被其他操作修改，请重新打开审查");
  const hunk = state.hunks.find(h => h.id === hunkId); if (!hunk) fail("没有这个改动块", 404);
  hunk.reverted = !hunk.reverted;
  const next = state.build(), remove = state.entry.before == null && state.hunks.every(h => h.reverted);
  const content = remove ? null : Buffer.from(next);
  // Persist both objects before touching the file; a failed ledger write restores the current bytes.
  if (state.disk) checkpoints._internals.putObject(root, state.disk);
  if (content) checkpoints._internals.putObject(root, content);
  if (remove) fs.rmSync(state.abs, { force: true }); else { fs.mkdirSync(path.dirname(state.abs), { recursive: true }); fs.writeFileSync(state.abs, content); }
  const entry = checkpoints.record(root, { session, tool: "revert_hunk", rel: state.entry.rel, before: state.disk, after: content, review: { origin: id, hunk: hunkId, reverted: hunk.reverted } });
  if (!entry) { if (state.disk == null) fs.rmSync(state.abs, { force: true }); else fs.writeFileSync(state.abs, state.disk); fail("保存回退记录失败，文件已恢复"); }
  return review(root, session, id);
}
module.exports = { review, revert };
