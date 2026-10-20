// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 OpenWorkBuddy Contributors
"use strict";
process.on("uncaughtException", (e) => { console.error(e.stack || e); process.exit(1); });
const { spawnSync } = require("child_process");
if (!process.versions.electron) {
  const result = spawnSync(require("electron"), [__filename], { stdio: "inherit", env: process.env, timeout: 60000 });
  if (result.error) console.error(result.error.message);
  process.exit(result.status === 0 ? 0 : 1);
}
const HOME = require("./lib/own-home")("share-ui");
const { app, BrowserWindow } = require("electron");
const fs = require("fs"), path = require("path"), http = require("http"), assert = require("assert/strict");
app.setPath("userData", path.join(HOME, "browser")); if (process.platform === "darwin" && app.dock) app.dock.hide();
const root = path.join(__dirname, ".."), read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const token = "x".repeat(43); let mode = 200, server, win;
const fixture = '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/css/ui.css"><body><div id="chat-scroll"></div></body>';
app.whenReady().then(async () => {
 try {
  server = http.createServer((req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const pathname = req.url.split("?")[0];
    if (["/shared.html", "/css/ui.css", "/css/shared.css", "/js/i18n.js", "/js/shared.js"].includes(pathname)) { res.setHeader("Content-Type", pathname.endsWith(".js") ? "text/javascript" : pathname.endsWith(".css") ? "text/css" : "text/html"); res.end(read("public" + pathname)); }
    else if (pathname.startsWith("/api/session-shares/")) { res.writeHead(mode, { "Content-Type": "application/json" }); res.end(JSON.stringify({ title: "保存", turns: [{ role: "user", text: '<img src=x onerror="window.fixtureExecuted=true">' }, { role: "assistant", text: "A complete result" }], files: [{ path: "folder/a b.md", size: 100 }] })); }
    else res.end(fixture);
  }); await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + server.address().port;
  win = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { contextIsolation: false, sandbox: false, backgroundThrottling: false } });
  await win.loadURL(base);
  const results = await win.webContents.executeJavaScript(read("public/js/i18n.js") + '\n' + read("public/js/app-10-share.js") + `\n(async()=>{
    const names=[]; const ok=(label,v)=>{if(!v)throw new Error(label);names.push(label)};
    var calls=[], active=false, fail=false, copied="";
    window.settingsCache={solo:false};window.sessionId="s_fixture";window.openSession=async(id)=>{window.sessionId=id};
    window.ic=()=>"";window.copyText=async(s)=>{copied=s;return true};
    window.fetch=async(url,opt)=>{calls.push([url,opt.method]);if(fail)return {ok:false,json:async()=>({error:"fixture error"})};if(opt.method==="POST")active=true;if(opt.method==="DELETE")active=false;return {ok:true,json:async()=>({active,url:"/shared.html#${token}"})}};
    await openSessionShare("s_fixture");
    ok("分享设置在页面里，没有弹窗或遮罩",!!document.getElementById("session-share-panel")&&!document.querySelector('dialog,[role="dialog"]'));
    ok("尚未分享时显示生成按钮",!!document.querySelector("[data-create]")&&!document.querySelector("[data-url]"));
    await document.querySelector("[data-create]").onclick();
    ok("点击后才生成链接",active&&calls.filter(x=>x[1]==="POST").length===1&&!!document.querySelector("[data-url]"));
    await document.querySelector("[data-copy]").onclick();
    ok("复制的是当前服务器的完整链接",copied===location.origin+"/shared.html#${token}");
    fail=true;await document.querySelector("[data-revoke]").onclick();
    ok("撤回失败时保留链接并说明错误",active&&!!document.querySelector("[data-url]")&&document.querySelector(".share-status").textContent.includes("fixture error"));
    fail=false;await document.querySelector("[data-revoke]").onclick();
    ok("成功撤回后原处恢复生成按钮",!active&&!!document.querySelector("[data-create]")&&!document.querySelector("[data-url]"));
    document.querySelector("[data-close]").click();ok("收起设置不触发撤回",!document.getElementById("session-share-panel")&&calls.filter(x=>x[1]==="DELETE").length===2);
    settingsCache.solo=true;const count=calls.length;await openSessionShare("s_fixture");ok("单人模式不显示入口，也不请求分享接口",calls.length===count&&!document.getElementById("session-share-panel"));
    return names;
  })()`, true);
  for (const name of results) console.log("✓ " + name);
  let more = 0;
  await win.loadURL(base + "/shared.html#" + token); await new Promise((r) => setTimeout(r, 100));
  const state = await win.webContents.executeJavaScript('({title:document.getElementById("shared-title").textContent,turns:document.querySelectorAll(".shared-turn").length,img:!!document.querySelector(".shared-text img"),text:document.querySelector(".shared-text").textContent,file:document.querySelector("#shared-files a").getAttribute("href"),editable:document.querySelectorAll("input,textarea,[contenteditable=true],button").length})');
  assert.equal(state.title, "保存"); assert.equal(state.turns, 2); assert.equal(state.img, false); assert.ok(state.text.includes("<img")); assert.equal(state.editable, 0); assert.equal(state.file, "/api/session-shares/" + token + "/file?path=folder%2Fa%20b.md"); console.log("✓ 只读页面展示完整文本与下载链接；用户内容无法执行 HTML");more++;
  await win.webContents.executeJavaScript('I18N.setLang("en")');
  assert.equal(await win.webContents.executeJavaScript('document.getElementById("shared-status").textContent'), "This page is read-only. You cannot edit or resume the task."); console.log("✓ 英文界面的只读说明已翻译");more++;
  mode = 401; await win.loadURL(base + "/shared.html?case=unauthorized#" + token); await new Promise((r) => setTimeout(r, 100));
  assert.equal(await win.webContents.executeJavaScript('document.getElementById("shared-login").getAttribute("href")'), "/?shared=" + token); console.log("✓ 未登录时提供回到分享任务的登录链接");more++;
  mode = 404; await win.loadURL(base + "/shared.html?case=revoked#" + token); await new Promise((r) => setTimeout(r, 100));
  assert.equal(await win.webContents.executeJavaScript('document.querySelectorAll(".shared-turn").length'), 0); console.log("✓ 撤回或无权查看时不残留正文");more++;
  console.log(`Share UI: ${results.length + more} checks passed`);
  win.destroy(); await new Promise((r) => server.close(r)); app.exit(0);
 } catch (e) { console.error(e.stack || e); if (win && !win.isDestroyed()) win.destroy(); if (server) server.close(); app.exit(1); }
});
