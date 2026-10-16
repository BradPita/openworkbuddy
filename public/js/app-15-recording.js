// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 OpenWorkBuddy Contributors
"use strict";
function mountBrowserRecording(pane) {
  const section=document.createElement("section");section.className="card-item browser-recording";
  section.innerHTML='<div class="t">录制操作生成技能</div><p class="d">只录制当前 Chrome 标签页的点击、滚动和填写位置，最多十分钟。输入值、密码和网址参数不保存；换到其他网站会停止。停止后先查看，再保存技能。</p><div class="share-buttons"><button class="btn-brand" data-record-start>开始录制当前页</button><button class="btn-plain" data-record-stop>停止并生成草稿</button><button class="btn-plain" data-record-discard>丢弃录制</button></div><p role="status" data-record-status></p><div data-record-draft hidden><label>技能名称<input data-record-name maxlength="80"></label><label>技能说明<input data-record-description maxlength="500"></label><label>技能内容<textarea data-record-content rows="12" spellcheck="false"></textarea></label><div class="share-buttons"><button class="btn-brand" data-record-save>保存技能</button><button class="btn-plain" data-record-download>下载技能草稿</button></div></div>';
  pane.appendChild(section);const $=s=>section.querySelector(s);let active=false;
  const status=text=>{$("[data-record-status]").textContent=I18N.t(text);};
  const call=async action=>{const r=await fetch("/api/browser/recording/"+action,{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"});const d=await r.json();if(!r.ok)throw Error(d.error||I18N.t("录制操作失败"));return d;};
  const paint=d=>{active=d.active;$("[data-record-start]").disabled=active;status(active?"录制中，切到 Chrome 手动完成操作，然后回来停止。":d.reason||"录制已停止");};
  const busy=async(action,fn)=>{section.querySelectorAll("button").forEach(b=>{b.disabled=true;});try{const d=await call(action);paint(d);if(fn)fn(d);}catch(e){status(e.message);}finally{section.querySelectorAll("button").forEach(b=>{b.disabled=false;});$("[data-record-start]").disabled=active;}};
  $("[data-record-start]").onclick=()=>busy("start",()=>{$("[data-record-draft]").hidden=true;$("[data-record-content]").value="";});
  $("[data-record-stop]").onclick=()=>busy("stop",d=>{if(!d.skill){status("没有录到操作，请先开始录制。");return;}$("[data-record-name]").value=d.skill.name+"-"+new Date().toISOString().replace(/[-:TZ.]/g,"").slice(0,14);$("[data-record-description]").value=d.skill.description;$("[data-record-content]").value=d.skill.content;$("[data-record-draft]").hidden=false;status("技能草稿已生成，请检查步骤和运行时参数。");});
  $("[data-record-discard]").onclick=()=>busy("discard",()=>{$("[data-record-draft]").hidden=true;$("[data-record-content]").value="";});
  const values=()=>({name:$("[data-record-name]").value.trim(),description:$("[data-record-description]").value,content:$("[data-record-content]").value});
  $("[data-record-save]").onclick=async e=>{e.target.disabled=true;try{const v=values();if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(v.name)||!v.content.trim())throw Error(I18N.t("请填写有效技能名称和内容"));const existing=await fetch("/api/skills/"+encodeURIComponent(v.name));if(existing.ok)throw Error(I18N.t("已有同名技能，请换个名字"));if(existing.status!==404)throw Error(I18N.t("无法检查技能名称，请重试"));const r=await fetch("/api/skills",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(v)});const d=await r.json();if(!r.ok)throw Error(d.error||I18N.t("保存技能失败"));status("技能已保存，可在技能库中使用。");}catch(err){status(err.message);}finally{e.target.disabled=false;}};
  $("[data-record-download]").onclick=()=>{const v=values(),blob=new Blob([`---\nname: ${JSON.stringify(v.name)}\ndescription: ${JSON.stringify(v.description)}\n---\n\n${v.content}\n`],{type:"text/markdown"}),url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download="SKILL.md";a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
  call("status").then(paint).catch(()=>status("连接 Chrome 后即可录制操作。"));
}
