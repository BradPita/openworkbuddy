// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 OpenWorkBuddy Contributors
"use strict";
let recording = null, recordingTimer = null;
const recordingView = () => recording ? {active:recording.active,count:recording.steps.length,origin:recording.origin,reason:recording.reason||""} : {active:false,count:0};
async function stopRecording(reason = "") {
  clearTimeout(recordingTimer);recordingTimer=null;
  if(recording){recording.active=false;recording.reason=reason;try{await chrome.scripting.executeScript({target:{tabId:recording.tab},func:()=>globalThis.__owbRecorderStop?.()});}catch{}}
  try{chrome.action.setBadgeText({text:""});}catch{}
}
async function injectRecording() {await chrome.scripting.executeScript({target:{tabId:recording.tab},files:["page-ops.js","recorder.js"]});}
Object.assign(OPS,{
  record_status:async()=>{if(recording?.active&&Date.now()>=recording.until)await stopRecording("录制已达到时长上限");return recordingView();},
  record_start:async()=>{
    if(recording?.active)throw Error("已有录制进行中，请先停止");
    const [tab]=await chrome.tabs.query({active:true,lastFocusedWindow:true});if(!tab?.id||blocked(tab.url))throw Error("请先打开一个可以录制的网页");
    await stopRecording();recording={active:true,tab:tab.id,origin:originOf(tab.url),steps:[],until:Date.now()+10*60*1000};
    try{await injectRecording();}catch(e){recording=null;throw e;}recordingTimer=setTimeout(()=>stopRecording("录制已达到时长上限"),10*60*1000);
    chrome.action.setBadgeText({text:"REC"});chrome.action.setBadgeBackgroundColor({color:"#b42318"});return recordingView();
  },
  record_stop:async()=>{await stopRecording();return {...recordingView(),steps:recording?.steps||[]};},
  record_discard:async()=>{await stopRecording();recording=null;return recordingView();}
});
chrome.runtime.onMessage.addListener((msg,sender)=>{
  if(msg?.type!=="record-step"||sender.id!==chrome.runtime.id||!recording?.active||sender.tab?.id!==recording.tab)return false;
  if(Date.now()>=recording.until||recording.steps.length>=200){stopRecording("录制已达到时长或步骤上限");return false;}
  if(originOf(sender.url||sender.tab.url)!==recording.origin){stopRecording("页面已切换到其他网站，录制已停止");return false;}
  const step=msg.step;if(!step||!["click","fill","scroll"].includes(step.action))return false;
  const clean=step.action==="scroll"?{action:"scroll",direction:step.direction==="up"?"up":"down"}:{action:step.action,selector:String(step.selector||"")};
  if(clean.selector&&!/^[a-z][a-z0-9-]*(?::nth-of-type\([1-9][0-9]{0,4}\))?(?: > [a-z][a-z0-9-]*(?::nth-of-type\([1-9][0-9]{0,4}\))?){0,9}$/.test(clean.selector))return false;
  if(clean.action!=="scroll"&&!clean.selector)return false;
  const last=recording.steps.at(-1);if(last&&JSON.stringify(last)===JSON.stringify(clean))return false;recording.steps.push(clean);return false;
});
chrome.tabs.onUpdated?.addListener(async(tabId,change,tab)=>{
  if(!recording?.active||tabId!==recording.tab)return;
  if(tab.url&&(blocked(tab.url)||originOf(tab.url)!==recording.origin)){await stopRecording("页面已切换到其他网站，录制已停止");return;}
  if(change.status==="complete")try{await injectRecording();}catch{await stopRecording("新页面无法录制");}
});
chrome.tabs.onRemoved?.addListener(tabId=>{if(recording?.tab===tabId)stopRecording("录制页面已关闭");});
