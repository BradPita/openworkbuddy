// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 OpenWorkBuddy Contributors
"use strict";
const { spawnSync } = require("child_process");
if (!process.versions.electron) { const r = spawnSync(require("electron"), [__filename], { stdio: "inherit", timeout: 60000 }); process.exit(r.status === 0 ? 0 : 1); }
const HOME = require("./lib/own-home")("review-ui");
const { app, BrowserWindow } = require("electron"); const fs=require("fs"),path=require("path"),http=require("http"),assert=require("assert/strict");
app.setPath("userData",path.join(HOME,"browser"));if(process.platform==="darwin")app.dock.hide();
app.whenReady().then(async()=>{
 let server,win;let count=0;const check=(n,v)=>{assert.ok(v,n);console.log("✓ "+n);count++;};
 try{
  server=http.createServer((_req,res)=>{res.setHeader("Content-Type","text/html");res.end('<body><div id="review"></div><textarea id="input"></textarea><div id="preview-panel" class="show" style="position:relative;width:500px"><button id="pv-annotate">Annotate</button><div id="pv-body" style="position:relative;height:300px;overflow:auto"><table><tr><th>Name</th><th>Count</th></tr><tr><td>Fixture item</td><td>12</td></tr></table><p>Unrelated footer</p></div></div></body>');});await new Promise(r=>server.listen(0,"127.0.0.1",r));
  win=new BrowserWindow({show:false,width:1000,height:800,webPreferences:{contextIsolation:false,sandbox:false,backgroundThrottling:false}});await win.loadURL("http://127.0.0.1:"+server.address().port);
  const read=p=>fs.readFileSync(path.join(__dirname,"..","public/js",p),"utf8");
  await win.webContents.insertCSS(fs.readFileSync(path.join(__dirname,"..","public/css/ui.css"),"utf8"));
  const result=await win.webContents.executeJavaScript(read("i18n.js")+"\n"+read("app-12-review.js")+"\n"+read("app-13-annotate.js")+`\n(async()=>{
    window.sessionId='s_fixture';window.pvCurrent='report.html';window.pvRoot='';window.toast=s=>{window.lastToast=s};window.refreshFilesCache=()=>{};
    let calls=[],reverted=false;window.fetch=async(u,o)=>{calls.push([u,o]);if(o?.method==='POST')reverted=!reverted;return {ok:true,json:async()=>({path:'report.html',hash:'fixture',current:true,hunks:[{id:'one',old_line:2,new_line:2,removed:['<script>private</script>\\n'],added:['new line\\n'],reverted}]})}};
    const wrap=document.getElementById('review');await openCheckpointReview(wrap,sessionId,'ck_fixture');
    const safe=!document.querySelector('.review-hunk script')&&wrap.textContent.includes('<script>private</script>');
    document.querySelectorAll('.review-line')[1].click();document.querySelector('.review-note textarea').value='Fix this line';document.querySelector('.review-note button').click();
    const draft=document.getElementById('input').value;await document.querySelector('.review-hunk>.step-rewind').onclick();const undone=document.querySelector('.review-hunk>.step-rewind').textContent.includes('撤销');
    sessionId='other';const before=document.getElementById('input').value;const cross=appendReviewDraft('s_fixture','wrong')===false&&document.getElementById('input').value===before;sessionId='s_fixture';
    wrap.remove();beginPreviewAnnotation();return {safe,draft,undone,cross,inline:!!document.querySelector('.annotation-overlay')&&!document.querySelector('dialog,[role=dialog]')};
  })()`,true);
  check("审查文本转义，逐行批注带文件、行号和要求",result.safe&&result.draft.includes('new line 2')&&result.draft.includes('Fix this line')&&result.draft.includes('report.html'));
  check("逐块回退后有撤销入口",result.undone);check("切换任务不能把批注写入另一条会话",result.cross);check("预览圈选在面板内进行",result.inline);
  const box=await win.webContents.executeJavaScript('(()=>{const r=document.querySelector(".annotation-overlay").getBoundingClientRect();return {x:r.left,y:r.top}})()');
  
  for(const event of [{type:"mouseDown",x:Math.round(box.x+1),y:Math.round(box.y+1),button:"left",clickCount:1},{type:"mouseMove",x:Math.round(box.x+180),y:Math.round(box.y+48),button:"left",movementX:179,movementY:47},{type:"mouseUp",x:Math.round(box.x+180),y:Math.round(box.y+48),button:"left",clickCount:1}]) { win.webContents.sendInputEvent(event); await new Promise(r=>setTimeout(r,50)); }
  await new Promise(r=>setTimeout(r,150));
  const annotation=await win.webContents.executeJavaScript('(()=>{document.querySelector(".preview-annotation textarea").value="Update selected cells";document.querySelector(".preview-annotation .btn-brand").click();return {draft:document.getElementById("input").value,overlay:!!document.querySelector(".annotation-overlay"),overflow:document.getElementById("pv-body").style.overflow}})()');

  check("选区含坐标、表格行列和修改要求，加入草稿后恢复阅读",annotation.draft.includes('Preview annotation')&&annotation.draft.includes('"row":2')&&annotation.draft.includes('Update selected cells')&&!annotation.overlay&&annotation.overflow==='auto');
  const cancel=await win.webContents.executeJavaScript('(()=>{beginPreviewAnnotation();document.querySelector(".preview-annotation .btn-plain").click();return !document.querySelector(".annotation-overlay")&&!document.querySelector(".preview-annotation")})()');check("取消批注清理选区与输入条",cancel);
  const probe=read("preview-probe.js");
  const frameResult=await win.webContents.executeJavaScript(`(async()=>{
    const frame=document.createElement('iframe');frame.setAttribute('sandbox','allow-scripts');frame.style.cssText='width:500px;height:200px';
    const loaded=new Promise(r=>frame.onload=r);frame.srcdoc='<p id="region-target">Selected fixture paragraph</p><script>'+${JSON.stringify(probe)}+'</script>';document.getElementById('pv-body').replaceChildren(frame);await loaded;
    return await new Promise((resolve,reject)=>{const id='fixture'.repeat(5),timer=setTimeout(()=>reject(Error('preview probe timeout')),2000);const receive=ev=>{if(ev.source===frame.contentWindow&&ev.data?.id===id){removeEventListener('message',receive);clearTimeout(timer);resolve(ev.data);}};addEventListener('message',receive);frame.contentWindow.postMessage({type:'owb-preview-region',id,rect:{x:0,y:0,width:500,height:150}},'*');});
  })()`,true);
  check("沙箱网页按请求 ID 返回选区文字与元素定位，不开放同源权限",frameResult.selected.some(v=>v.selector==="#region-target"&&v.text==="Selected fixture paragraph"));
  console.log(`Review UI: ${count} checks passed`);win.destroy();await new Promise(r=>server.close(r));app.exit(0);
 }catch(e){console.error(e.stack||e);if(win&&!win.isDestroyed())win.destroy();if(server)server.close();app.exit(1);}
});
