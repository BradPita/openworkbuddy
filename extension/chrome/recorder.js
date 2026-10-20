// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 OpenWorkBuddy Contributors
"use strict";
(() => {
  if (globalThis.__owbRecorderStop) globalThis.__owbRecorderStop();
  const listeners=[];let lastScroll=0, lastY=scrollY;
  const css=el=>{const parts=[];while(el&&el.nodeType===1&&parts.length<10){const tag=el.tagName.toLowerCase();const peers=el.parentElement?[...el.parentElement.children].filter(x=>x.tagName===el.tagName):[el];parts.unshift(tag+":nth-of-type("+(peers.indexOf(el)+1)+")");el=el.parentElement;}return parts.join(" > ");};
  const send=step=>{try{chrome.runtime.sendMessage({type:"record-step",step}).catch(()=>{});}catch{}};
  const listen=(name,fn)=>{addEventListener(name,fn,true);listeners.push([name,fn]);};
  const safe=el=>!OWBPage.sensitiveWhy({type:el.type,autocomplete:el.autocomplete,name:el.name,id:el.id,placeholder:el.placeholder,label:el.getAttribute("aria-label")});
  listen("click",event=>{if(!event.isTrusted)return;const el=event.target.closest("button,a,input,select,textarea,[role=button],[role=link]");if(!el||!safe(el))return;send({action:"click",selector:css(el)});});
  listen("change",event=>{if(!event.isTrusted)return;const el=event.target;if(!el.matches("input,textarea,select")||el.matches("input[type=checkbox],input[type=radio],input[type=file]")||!safe(el))return;send({action:"fill",selector:css(el)});});
  listen("scroll",event=>{if(!event.isTrusted||Date.now()-lastScroll<500)return;lastScroll=Date.now();const y=scrollY,direction=y<lastY?"up":"down";lastY=y;send({action:"scroll",direction});});
  globalThis.__owbRecorderStop=()=>{for(const [name,fn]of listeners)removeEventListener(name,fn,true);delete globalThis.__owbRecorderStop;};
})();
