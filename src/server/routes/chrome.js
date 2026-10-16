// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 OpenWorkBuddy Contributors · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 设置 → 浏览器 那一节的接口：
 *   GET  /api/browser/status          这个人的 Chrome 配没配、连没连上
 *   POST /api/browser/pair-code       生成配对码（十分钟有效，用一次作废）
 *   POST /api/browser/disconnect      解除配对：令牌作废，连着的当场断开
 *   POST /api/browser/open-folder     桌面版：在访达 / 资源管理器里打开扩展所在的文件夹
 *   GET  /api/browser/extension.zip   服务器版：扩展打成 zip 下载，解压后「加载已解压的扩展程序」
 *
 * 一律按登录的这个人算（req.user.username）：组织里各人配各人的，看不见、也断不了别人的。
 * 线本身（WebSocket、令牌、配对码）在 src/core/ext/chrome-link.js。
 *
 * 写法照 src/server/routes/library.js：路由写在顶层，依赖由 createChromeRouter(deps) 一次填上，不回头 require server.js。
 */
const fs = require("fs");
const path = require("path");
const express = require("express");
const { skillOf } = require("../../core/ext/browser-recording");
const chromeLink = require("../../core/ext/chrome-link");
const { crc32 } = require("../../util/thumb-png");

// 下面这几个由 createChromeRouter(deps) 填上
let canOpenFolder, openFolder, extDir, copyTo, packaged, desktop;

const app = express.Router({ caseSensitive: true });
const whoOf = (req) => String((req.user && req.user.username) || "");

app.get("/api/browser/status", (req, res) => {
  res.json({
    ...chromeLink.status(whoOf(req)),
    serving: chromeLink.serving(),
    desktop: !!desktop,
    can_open_folder: !!canOpenFolder(req),
    ws_path: chromeLink.WS_PATH,
  });
});

app.post("/api/browser/pair-code", (req, res) => {
  const who = whoOf(req);
  if (!who) return res.status(401).json({ error: "没登录，生成不了配对码" });
  if (!chromeLink.serving()) return res.status(503).json({ error: "这个服务现在接不了 Chrome，重启 OpenWorkBuddy 再试" });
  res.json(chromeLink.newPairCode(who));
});

app.post("/api/browser/disconnect", (req, res) => {
  const who = whoOf(req);
  if (!who) return res.status(401).json({ error: "没登录" });
  res.json(chromeLink.disconnect(who));
});

app.post("/api/browser/recording/:action", async (req, res) => {
  const who = whoOf(req); if (!who) return res.status(401).json({ error: "请先登录" });
  const actions = { start: "record_start", stop: "record_stop", status: "record_status", discard: "record_discard" };
  if (!Object.hasOwn(actions, req.params.action)) return res.status(404).json({ error: "没有这个录制操作" });
  try { const reply = await chromeLink.call(who, actions[req.params.action], {}); if (!reply.ok) throw Error(); const recording = reply.data; res.set("Cache-Control", "no-store"); const view = { active: !!recording.active, count: Number(recording.count) || 0, origin: recording.origin, reason: recording.reason }; res.json(req.params.action === "stop" && recording.steps?.length ? { ...view, skill: skillOf(recording) } : view); }
  catch { res.status(400).json({ error: "录制操作未完成，请检查 Chrome 连接和扩展版本" }); }
});

/** 扩展那几个文件（平铺一层，没有子目录） */
function extFiles() {
  return fs.readdirSync(extDir).filter((n) => !n.startsWith(".")).sort().map((n) => ({ name: n, data: fs.readFileSync(path.join(extDir, n)) }));
}

app.post("/api/browser/open-folder", async (req, res) => {
  if (!canOpenFolder(req)) return res.status(403).json({ error: "只有桌面版能直接打开文件夹，服务器版请下载扩展" });
  let dir = extDir;
  if (packaged()) {
    // 安装包里的扩展躺在 .app 里面：选文件夹的框进不去，升级换 .app 还会连根换掉。
    // 拷一份到数据目录，升级也不挪——Chrome 按文件夹认扩展，挪了就要重新配对
    try {
      fs.mkdirSync(copyTo, { recursive: true });
      for (const f of extFiles()) fs.writeFileSync(path.join(copyTo, f.name), f.data);
      dir = copyTo;
    } catch (e) {
      return res.status(500).json({ error: "扩展文件夹准备不出来：" + String((e && e.message) || e).slice(0, 200) });
    }
  }
  const r = await openFolder(dir);
  res.json({ ok: !!r.ok, error: r.error || "", path: dir });
});

/** 只存不压的 zip：五个小文件，用不着压缩；文件名按 UTF-8 标 */
function zipStore(files) {
  const parts = [];
  const central = [];
  let off = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const crc = crc32(f.data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12); // 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(f.data.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, f.data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(0, 10);
    c.writeUInt16LE(0, 12);
    c.writeUInt16LE(0x21, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(f.data.length, 20);
    c.writeUInt32LE(f.data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(off, 42);
    central.push(c, name);
    off += 30 + name.length + f.data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, end]);
}

app.get("/api/browser/extension.zip", (_req, res) => {
  let files;
  try { files = extFiles(); } catch { return res.status(404).json({ error: "这个版本里没带 Chrome 扩展" }); }
  const zip = zipStore(files.map((f) => ({ name: "openworkbuddy-chrome/" + f.name, data: f.data })));
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", 'attachment; filename="openworkbuddy-chrome.zip"');
  res.setHeader("Cache-Control", "no-store");
  res.end(zip);
});

/**
 * @param {{ canOpenFolder:(req:any)=>boolean, openFolder:(dir:string)=>Promise<{ok:boolean,error?:string}>,
 *   extDir:string, copyTo:string, packaged:()=>boolean, desktop:boolean }} deps
 */
function createChromeRouter(deps) {
  ({ canOpenFolder, openFolder, extDir, copyTo, packaged, desktop } = deps);
  return app;
}

module.exports = { createChromeRouter, zipStore };
