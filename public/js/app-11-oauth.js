// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 OpenWorkBuddy Contributors
"use strict";
function openMcpOAuth(card, server, changed) {
  if (card.querySelector(".mcp-oauth-panel")) { card.querySelector(".mcp-oauth-panel").querySelector("[data-start]").focus(); return; }
  const panel = document.createElement("section"); panel.className = "mcp-oauth-panel";
  panel.innerHTML = `<p>在服务商页面确认授权。令牌保存在本机，任务中自动使用并刷新。</p>
    <details><summary>服务需要预注册客户端时填写</summary>
      <label>Client ID<input data-client autocomplete="off"></label>
      <label>Client Secret<input data-secret type="password" autocomplete="off"></label>
      <label>权限范围<input data-scope autocomplete="off" placeholder="由服务声明所需权限"></label>
    </details>
    <div class="share-buttons"><button type="button" class="btn-brand" data-start>打开服务商授权页</button>${server.oauth?.authorized ? '<button type="button" class="btn-plain" data-remove>移除本机授权</button>' : ""}<button type="button" class="btn-plain" data-cancel hidden>取消授权</button><button type="button" class="btn-plain" data-close>收起</button></div>
    <p class="mcp-oauth-status" role="status"></p><a data-auth-link hidden target="_blank" rel="noopener noreferrer">在浏览器完成授权</a>`;
  card.appendChild(panel);
  const status = (text) => { if (panel.isConnected) panel.querySelector(".mcp-oauth-status").textContent = I18N.t(text); };
  const post = async (action, body) => {
    const response = await fetch("/api/mcp/oauth/" + action, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || I18N.t("OAuth 授权失败，请重试")); return data;
  };
  panel.querySelector("[data-close]").onclick = () => panel.remove();
  const remove = panel.querySelector("[data-remove]");
  if (remove) remove.onclick = async () => {
    remove.disabled = true;
    try { await post("remove", { name: server.name }); status("本机授权已移除；服务商的账号授权可在其设置页管理"); changed(); }
    catch (error) { status(error.message); } finally { remove.disabled = false; }
  };
  const start = panel.querySelector("[data-start]"), cancel = panel.querySelector("[data-cancel]");
  let cancelled = false, activeFlow = null;
  cancel.onclick = async () => { cancelled = true; cancel.disabled = true; if (activeFlow) await post("cancel", { flow_id: activeFlow }).catch(() => {}); status("授权已取消"); };
  start.onclick = async () => {
    start.disabled = true; cancelled = false; cancel.hidden = false; cancel.disabled = false; status("正在发现授权服务…");
    const tab = window.open("about:blank", "_blank"); if (tab) tab.opener = null;
    let flow = null;
    try {
      const data = await post("start", { name: server.name, redirect_uri: new URL("/api/mcp/oauth/callback", location.origin).href,
        client_id: panel.querySelector("[data-client]").value.trim(), client_secret: panel.querySelector("[data-secret]").value, scope: panel.querySelector("[data-scope]").value.trim() });
      flow = data.flow_id; activeFlow = flow;
      if (cancelled) throw new Error("授权已取消");
      const url = new URL(data.authorization_url); if (!/^https?:$/.test(url.protocol)) throw new Error("OAuth 地址不合法");
      panel.querySelector("[data-secret]").value = "";
      const link = panel.querySelector("[data-auth-link]"); link.href = url.href; link.hidden = false;
      if (tab) tab.location.replace(url.href);
      else window.open(url.href, "_blank", "noopener,noreferrer");
      status("等待你在服务商页面确认授权…");
      const until = Math.min(Number(data.expires_at) || Date.now() + 600000, Date.now() + 600000);
      while (Date.now() < until) {
        if (cancelled) throw new Error("授权已取消");
        const result = await post("finish", { flow_id: flow });
        if (result.ready) {
          flow = null; activeFlow = null;
          status(result.connected ? "OAuth 授权完成，连接器已连接" : result.enabled === false ? "OAuth 授权完成，连接器仍处于关闭状态" : "OAuth 授权完成，请检查连接器状态");
          if (panel.isConnected) changed(); return;
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      throw new Error("授权等待已超时，请重新开始");
    } catch (error) { if (tab && !flow) { try { tab.close(); } catch {} } status(error.message); }
    finally { if (flow) await post("cancel", { flow_id: flow }).catch(() => {}); start.disabled = false; activeFlow = null; cancel.hidden = true; }
  };
  start.focus();
}
