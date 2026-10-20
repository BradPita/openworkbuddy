// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 OpenWorkBuddy Contributors
"use strict";
async function openSessionShare(sid) {
  if (!settingsCache || settingsCache.solo !== false) return;
  if (sessionId !== sid) await openSession(sid);
  if (sessionId !== sid) return;
  document.getElementById("session-share-panel")?.remove();
  const panel = document.createElement("section");
  panel.id = "session-share-panel"; panel.className = "session-share-panel"; panel.dataset.sid = sid;
  panel.setAttribute("aria-label", I18N.t("组织内只读分享"));
  panel.innerHTML = `<div class="share-head"><strong>组织内只读分享</strong><button type="button" class="icon-btn" data-close aria-label="收起分享设置">${ic("x")}</button></div><p>同组织成员登录后可查看对话和成果文件。链接可随时撤回。</p><div class="share-controls"></div><p class="share-status" role="status"></p>`;
  const scroll = document.getElementById("chat-scroll"); if (!scroll) return;
  scroll.prepend(panel); panel.querySelector("[data-close]").onclick = () => panel.remove();
  panel.scrollIntoView({ block: "nearest" });
  const live = () => panel.isConnected && sessionId === sid;
  const status = (msg) => { if (live()) panel.querySelector(".share-status").textContent = I18N.t(msg); };
  async function call(method) {
    const response = await fetch("/api/session/" + encodeURIComponent(sid) + "/share", { method });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || I18N.t("分享设置保存失败"));
    return data;
  }
  function draw(data) {
    if (!live()) return;
    const controls = panel.querySelector(".share-controls");
    const active = !!data.active && /^\/shared\.html#[A-Za-z0-9_-]{43}$/.test(data.url || "");
    controls.innerHTML = active
      ? `<label>只读链接<input type="text" readonly data-url aria-label="只读链接" translate="no"></label><div class="share-buttons"><button type="button" class="ui-btn" data-copy>复制链接</button><button type="button" class="ui-btn" data-revoke>撤回分享</button></div>`
      : '<button type="button" class="ui-btn primary" data-create>生成只读链接</button>';
    if (active) {
      controls.querySelector("[data-url]").value = new URL(data.url, location.origin).href;
      controls.querySelector("[data-copy]").onclick = async () => status(await copyText(controls.querySelector("[data-url]").value) ? "链接已复制" : "复制失败，请手动复制链接");
    }
    const button = controls.querySelector(active ? "[data-revoke]" : "[data-create]");
    button.onclick = async () => {
      button.disabled = true; status("正在保存…");
      try { const next = await call(active ? "DELETE" : "POST"); draw(next); status(active ? "分享已撤回，原链接立即失效" : "链接已生成"); }
      catch (error) { status(error.message); }
      finally { button.disabled = false; }
    };
  }
  status("正在读取分享设置…");
  try { draw(await call("GET")); status(""); } catch (error) { status(error.message); }
}
