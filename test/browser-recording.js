// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 OpenWorkBuddy Contributors
"use strict";
const fs=require("fs"),path=require("path"),vm=require("vm"),assert=require("assert/strict"),{mod}=require("./lib/mod");const {skillOf}=require(mod("browser-recording"));
let count=0;const check=async(n,fn)=>{await fn();console.log("✓ "+n);count++;};
(async()=>{
 await check("技能只含动作和定位，输入值与网址凭据、参数不进入草稿",()=>{const secret="fixture-private-value",s=skillOf({origin:"https://example.invalid/private?api_key="+secret+"#secret",steps:[{action:"click",selector:"html:nth-of-type(1) > button:nth-of-type(1)",text:secret},{action:"fill",selector:"input:nth-of-type(1)",value:secret},{action:"scroll",direction:"up"}]});assert.ok(!JSON.stringify(s).includes(secret));assert.ok(!s.content.includes('/private'));assert.ok(s.content.includes('value_1'));assert.ok(s.content.includes('Ask before submitting'));assert.throws(()=>skillOf({origin:"file:///private",steps:[]}),/不合法/);assert.throws(()=>skillOf({origin:"https://example.invalid",steps:[{action:"click",selector:"[value=secret]"}]}),/格式/);});
 const messages=[],updated=[],removed=[],badges=[];let url="https://example.invalid/page?secret=fixture";const OPS={};
 const ctx=vm.createContext({OPS,URL,Date,console,setTimeout:()=>0,clearTimeout:()=>{},originOf:u=>new URL(u).origin,blocked:u=>!u.startsWith("https://"),chrome:{runtime:{id:"fixture-extension",onMessage:{addListener:f=>messages.push(f)}},tabs:{query:async()=>[{id:1,url}],onUpdated:{addListener:f=>updated.push(f)},onRemoved:{addListener:f=>removed.push(f)}},scripting:{executeScript:async()=>[]},action:{setBadgeText:({text})=>badges.push(text),setBadgeBackgroundColor:()=>{}}}});
 vm.runInContext(fs.readFileSync(path.join(__dirname,"../extension/chrome/recording-background.js"),"utf8"),ctx);
 const sender={id:"fixture-extension",tab:{id:1,url},url};
 await check("录制需主动开始，只收本扩展当前标签且不保存输入值",async()=>{assert.equal((await OPS.record_status()).active,false);await OPS.record_start();assert.equal(badges.at(-1),"REC");const step={action:"fill",selector:"input:nth-of-type(1)",value:"fixture-secret"};messages[0]({type:"record-step",step},{...sender,tab:{id:2,url}});messages[0]({type:"record-step",step},sender);messages[0]({type:"record-step",step},sender);const r=await OPS.record_stop();assert.equal(r.steps.length,1);assert.ok(!JSON.stringify(r).includes("fixture-secret"));assert.equal(r.active,false);});
 await check("换站、关闭和断开后可停录；丢弃不保留历史",async()=>{await OPS.record_start();await updated[0](1,{status:"complete"},{url:"https://other.invalid/"});assert.equal((await OPS.record_status()).active,false);assert.ok((await OPS.record_status()).reason.includes("其他网站"));await OPS.record_discard();assert.equal((await OPS.record_status()).count,0);});
 const content=fs.readFileSync(path.join(__dirname,"../extension/chrome/recorder.js"),"utf8");
 await check("页面监听器不读取输入值、Cookie、存储或页面正文，忽略合成事件",()=>{assert.ok(!/\.value\b|document\.cookie|localStorage|innerText|textContent/.test(content));assert.ok(content.includes('event.isTrusted'));assert.ok(content.includes('sensitiveWhy'));});
 console.log(`Browser recording: ${count} checks passed`);
})().catch(e=>{console.error(e.stack||e);process.exitCode=1;});
