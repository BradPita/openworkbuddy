// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 OpenWorkBuddy Contributors
"use strict";
const {spawnSync}=require("child_process");if(!process.versions.electron){const r=spawnSync(require("electron"),[__filename],{stdio:"inherit",timeout:60000});process.exit(r.status===0?0:1);}
const HOME=require("./lib/own-home")("ui-language");const{app,BrowserWindow}=require("electron"),fs=require("fs"),path=require("path"),http=require("http"),assert=require("assert/strict");app.setPath("userData",path.join(HOME,"browser"));if(process.platform==="darwin")app.dock.hide();
app.whenReady().then(async()=>{let server,win;try{
 server=http.createServer((_req,res)=>{res.setHeader("Content-Type","text/html");res.end('<body><div id="pane"></div><div id="card"></div><div id="chat-scroll"></div><textarea id="input"></textarea></body>');});await new Promise(r=>server.listen(0,"127.0.0.1",r));win=new BrowserWindow({show:false,width:1000,height:1000,webPreferences:{contextIsolation:false,sandbox:false,backgroundThrottling:false}});await win.loadURL("http://127.0.0.1:"+server.address().port);
 const read=p=>fs.readFileSync(path.join(__dirname,"../public/js",p),"utf8");const init=`window.pendingModel=undefined;window.settingsCache={solo:false};window.sessionId='s_fixture';window.sessions=[];window.runningSessions=new Set();window.toast=()=>{};window.copyText=async()=>true;window.fetch=async(u,o)=>({ok:true,status:200,json:async()=>u==='/api/my-task-costs'?{month:'2026-10',team:{cost:1,unknown:0},personal:{cost:2,unknown:1}}:{active:false,count:0,ready:true,connected:true,flow_id:'fixture',authorization_url:'https://example.invalid/authorize',expires_at:Date.now()+10000}});`;
 const names=await win.webContents.executeJavaScript(read("i18n.js")+'\n'+init+'\n'+read("app-11-oauth.js")+'\n'+read("app-12-review.js")+'\n'+read("app-14-team.js")+'\n'+read("app-15-recording.js")+`\n(async()=>{
  const names=[],ok=(n,v)=>{if(!v)throw Error(n);names.push(n)};I18N.setLang('en');
  mountBrowserRecording(document.getElementById('pane'));openMcpOAuth(document.getElementById('card'),{name:'fixture',oauth:{authorized:true}},()=>{});document.querySelector('.mcp-oauth-panel details').open=true;document.querySelector('[data-record-draft]').hidden=false;I18N.apply(document.body);
  I18N.apply(document.body);await new Promise(r=>setTimeout(r,30));let missing=I18N.untranslated(document.body);ok('英文新增界面没有漏翻文字：'+JSON.stringify(missing),!missing.length);
  sessionId=null;settingsCache.active_model='my:mine';settingsCache.models=[{name:'my:mine',own:true,team_available:false},{name:'hidden',team_available:false},{name:'shared',team_available:true}];
  loadTaskBillingScope('s_team','team');sessionId='s_team';
  ok('历史团队任务只显示共享模型，排除私人 Key',currentTaskBillingScope()==='team'&&taskModelChoices(settingsCache.models).map(x=>x.name).join(',')==='shared');
  adoptTaskBillingScope('s_new');sessionId='s_new';ok('隐藏类型切换后新任务默认个人归属',taskBillingBody('s_new').billing_scope==='personal');
  sessionId=null;resetTaskBillingScope();ok('新建另一条任务恢复个人模式，不继承上条团队归属',currentTaskBillingScope()==='personal');
  const label=document.createElement('button');label.textContent='这是故意漏翻的测试';document.body.appendChild(label);ok('未翻译的按钮会被测试捕获',I18N.untranslated(document.body).some(x=>x.text===label.textContent));
  label.textContent='Translated';label.title='故意漏翻的标题';ok('标题和可访问标签也纳入检查',I18N.untranslated(document.body).some(x=>x.attribute==='title'));label.remove();
  const user=document.createElement('p');user.dataset.i18nSkip='';user.textContent='用户自己的中文内容';document.body.appendChild(user);const code=document.createElement('pre');code.textContent='源码中文';document.body.appendChild(code);const input=document.getElementById('input');input.value='用户草稿';ok('用户内容、源码和输入值不被误报',!I18N.untranslated(document.body).length);
  const hidden=document.createElement('div');hidden.hidden=true;hidden.textContent='隐藏分支';document.body.appendChild(hidden);ok('默认只检查可见界面，完整扫描可以检查隐藏分支',!I18N.untranslated(document.body).length&&I18N.untranslated(document.body,{visibleOnly:false}).some(x=>x.text==='隐藏分支'));
  return names;
 })()`,true);names.forEach(n=>console.log('✓ '+n));assert.ok(names.length===8);
 const I18N = require("../public/js/i18n"), catalog = require("../src/core/ext/mcp-catalog"); for (const item of catalog.ITEMS) assert.ok(!/[\u3400-\u9fff]/.test(I18N.tr(item.desc,"en")), "Untranslated connector description: " + item.name); console.log("✓ All preset connector descriptions are translated");console.log(`UI language: ${names.length} checks passed`);win.destroy();await new Promise(r=>server.close(r));app.exit(0);
}catch(e){console.error(e.stack||e);if(win&&!win.isDestroyed())win.destroy();if(server)server.close();app.exit(1);}});
