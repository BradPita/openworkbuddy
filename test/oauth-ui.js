// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 OpenWorkBuddy Contributors
"use strict";
const { spawnSync } = require("child_process");
if (!process.versions.electron) { const r = spawnSync(require("electron"), [__filename], { stdio: "inherit", timeout: 60000 }); process.exit(r.status === 0 ? 0 : 1); }
const HOME = require("./lib/own-home")("oauth-ui");
const { app, BrowserWindow } = require("electron");
const fs = require("fs"), path = require("path"), http = require("http");
app.setPath("userData", path.join(HOME, "browser")); if (process.platform === "darwin") app.dock.hide();
app.whenReady().then(async () => {
 let win, server;
 try {
  server = http.createServer((_req, res) => { res.setHeader("Content-Type", "text/html"); res.end('<body><div id="card"></div></body>'); }); await new Promise(r => server.listen(0, "127.0.0.1", r));
  win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: false, sandbox: false, backgroundThrottling: false } });
  await win.loadURL("http://127.0.0.1:" + server.address().port);
  const source = p => fs.readFileSync(path.join(__dirname, "..", "public/js", p), "utf8");
  const results = await win.webContents.executeJavaScript(source("i18n.js") + "\n" + source("app-11-oauth.js") + `\n(async()=>{
   I18N.setLang('en');
   const names=[], ok=(n,v)=>{if(!v)throw Error(n);names.push(n)};
   let calls=[], opened=0, replaced='', closed=0, changes=0, mode='ok'; const card=document.getElementById('card');
   window.open=()=>{opened++;return {opener:{},location:{replace:u=>{replaced=u}},close:()=>{closed++}}};
   window.fetch=async(u,o)=>{const body=JSON.parse(o.body);calls.push({u,body});return {ok:mode!=='fail',json:async()=>mode==='fail'?{error:'fixture failed'}:u.endsWith('/start')?{flow_id:'fixture-flow',authorization_url:'https://auth.example.invalid/authorize',expires_at:Date.now()+10000}:u.endsWith('/finish')?{ready:true,connected:true}: {ok:true}}};
   const show=()=>openMcpOAuth(card,{name:'fixture',oauth:{authorized:true}},()=>{changes++});show();
   ok('授权设置在连接器内展开，没有应用弹窗',!!card.querySelector('.mcp-oauth-panel')&&!document.querySelector('dialog,[role=dialog]'));
   ok('展开设置不会自动打开外部网页',opened===0&&calls.length===0);
   card.querySelector('[data-secret]').value='fixture-secret';await card.querySelector('[data-start]').onclick();
   ok('明确点击后打开服务商网页，回调为当前工作台',opened===1&&replaced.startsWith('https://auth.example.invalid/')&&calls[0].body.redirect_uri===location.origin+'/api/mcp/oauth/callback');
   ok('完成后清空临时密钥，恢复按钮并刷新状态',card.querySelector('[data-secret]').value===''&&!card.querySelector('[data-start]').disabled&&changes===1&&card.querySelector('.mcp-oauth-status').textContent==='OAuth authorization complete. The connector is connected.');
   mode='fail';await card.querySelector('[data-start]').onclick();ok('失败保留可重试的面板并关闭空白页',closed===1&&!card.querySelector('[data-start]').disabled&&card.textContent.includes('fixture failed'));
   mode='ok';let targets=[];window.open=(u)=>{targets.push(u);return null};await card.querySelector('[data-start]').onclick();ok('桌面端拒绝空白窗口时仍请求打开真实授权网址',targets[0]==='about:blank'&&targets[1]==='https://auth.example.invalid/authorize');
   mode='ok';await card.querySelector('[data-remove]').onclick();ok('移除动作单独请求且说明上游授权仍由服务商管理',calls.at(-1).u.endsWith('/remove')&&card.querySelector('.mcp-oauth-status').textContent==='Local authorization removed. Manage account authorization in the provider settings.');
   card.querySelector('[data-close]').click();ok('收起不冒充移除授权',!card.children.length&&calls.filter(x=>x.u.endsWith('/remove')).length===1);
   I18N.setLang('en');show();I18N.apply(card);ok('授权操作支持英文',card.querySelector('[data-start]').textContent==='Open provider authorization');
   card.querySelector('[data-close]').click();I18N.setLang('zh');show();I18N.apply(card);ok('切换中文后授权操作仍可用',card.querySelector('[data-start]').textContent==='打开服务商授权页');
   return names;
  })()`, true);
  results.forEach(n => console.log("✓ " + n)); console.log(`OAuth UI: ${results.length} checks passed`);win.destroy();await new Promise(r => server.close(r));app.exit(0);
 } catch(e) {console.error(e.stack||e);if(win&&!win.isDestroyed())win.destroy();if(server)server.close();app.exit(1);}
});
