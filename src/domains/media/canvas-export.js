// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 OpenWorkBuddy Contributors
"use strict";
const fs = require("fs");
const path = require("path");
const JSZip = require("jszip");

const MEDIA_EXT = /\.(png|jpe?g|webp|gif|bmp|avif|svg|mp4|mov|webm|m4v|mkv|mp3|wav|m4a|aac|flac|ogg)$/i;
const FILE_KEYS = new Set(["path", "url", "first_frame", "last_frame", "video", "audio", "image", "reference", "ref", "voice_file", "file", "subtitled", "reference_video", "output", "replaced", "rel"]);

function canvasExportPlan(root, state, selection) {
  const nodes = Array.isArray(state.nodes) ? state.nodes : [], edges = Array.isArray(state.edges) ? state.edges : [];
  const selected = new Set(Array.isArray(selection) ? selection.map(String) : []);
  const ids = new Set(nodes.map((node) => String(node.id)));
  if (selected.size && [...selected].some((id) => !ids.has(id))) throw new Error("选中的节点已变化，请刷新画布后再导出。");
  const endpoint = (value) => String(value?.id || value || "");
  const include = selected.size ? new Set(selected) : new Set(ids);
  // 选中一张生成卡时，把它依赖的上游一起带走，避免只带结果却丢了创作条件。
  if (selected.size) {
    const parents = new Map();
    for (const edge of edges) { const to = endpoint(edge.target); if (!parents.has(to)) parents.set(to, []); parents.get(to).push(endpoint(edge.source)); }
    const pending = [...selected];
    while (pending.length) for (const from of parents.get(pending.pop()) || []) if (ids.has(from) && !include.has(from)) { include.add(from); pending.push(from); }
  }
  const snapshot = { ...state, nodes: nodes.filter((node) => include.has(String(node.id))), edges: edges.filter((edge) => include.has(endpoint(edge.source)) && include.has(endpoint(edge.target))) };
  const refs = new Set();
  const walk = (value, key = "", depth = 0) => {
    if (depth > 16 || !value) return;
    if (typeof value === "string") { if ((FILE_KEYS.has(key) || key === "reference_images") && MEDIA_EXT.test(value)) refs.add(value); return; }
    if (Array.isArray(value)) value.forEach((item) => walk(item, key, depth + 1));
    else if (typeof value === "object") Object.entries(value).forEach(([k, item]) => walk(item, k, depth + 1));
  };
  snapshot.nodes.forEach((node) => walk(node.payload));
  const rootReal = fs.realpathSync(root), files = [], missing = [], seen = new Set();
  for (const ref of refs) {
    // 导出不根据同名文件猜路径，也不下载外部 URL。
    if (!path.isAbsolute(ref) && /^[a-z][a-z\d+.-]*:/i.test(ref)) { missing.push({ reference: ref, reason: "外部地址未打包" }); continue; }
    const full = path.resolve(rootReal, ref.replace(/\\/g, "/")), rel = path.relative(rootReal, full);
    if (!rel || rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) { missing.push({ reference: ref, reason: "不在当前项目内" }); continue; }
    try {
      const real = fs.realpathSync(full), resolved = path.relative(rootReal, real);
      if (!resolved || resolved === ".." || resolved.startsWith(".." + path.sep) || path.isAbsolute(resolved)) throw new Error("文件指向项目外");
      const stat = fs.statSync(real); if (!stat.isFile()) throw new Error("不是文件");
      const archive = rel.split(path.sep).join("/");
      if (!seen.has(archive)) { files.push({ path: real, archive, bytes: stat.size }); seen.add(archive); }
    } catch { missing.push({ reference: ref, reason: "文件不存在或无法读取" }); }
  }
  if (files.reduce((sum, file) => sum + file.bytes, 0) > 0xffffffff) throw new Error("导出包超过 4GB，请按选中节点分批导出。");
  return { snapshot, files, manifest: { version: 1, createdAt: new Date().toISOString(), selected: [...selected], nodes: snapshot.nodes.length, files: files.map(({ archive, bytes }) => ({ path: archive, bytes })), missing } };
}

function canvasExportStream(plan) {
  const zip = new JSZip();
  zip.file("canvas.json", JSON.stringify(plan.snapshot, null, 2));
  zip.file("manifest.json", JSON.stringify(plan.manifest, null, 2));
  for (const file of plan.files) zip.file(file.archive, fs.createReadStream(file.path));
  // 媒体文件通常已经压缩，逐文件流式输出，避免把整段视频读成一个大 Buffer。
  return zip.generateNodeStream({ type: "nodebuffer", streamFiles: true, compression: "STORE" });
}
module.exports = { canvasExportPlan, canvasExportStream };
