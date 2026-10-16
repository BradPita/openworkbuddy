// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 OpenWorkBuddy Contributors
"use strict";
(async () => {
  const token = location.hash.slice(1), status = document.getElementById("shared-status");
  const show = (s) => { status.textContent = I18N.t(s); };
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) { show("分享链接不完整"); return; }
  const base = "/api/session-shares/" + encodeURIComponent(token);
  try {
    const response = await fetch(base);
    if (response.status === 401) {
      show("请使用本组织账号登录后查看");
      const link = document.getElementById("shared-login"); link.href = "/?shared=" + encodeURIComponent(token); link.hidden = false; return;
    }
    if (!response.ok) { show("分享已撤回或当前账号无权查看"); return; }
    const data = await response.json();
    const title = document.getElementById("shared-title"); title.setAttribute("data-i18n-skip", ""); title.textContent = data.title || I18N.t("只读任务");
    const turns = document.getElementById("shared-turns");
    for (const turn of data.turns || []) {
      const article = document.createElement("article"); article.className = "shared-turn " + (turn.role === "user" ? "user" : "assistant");
      const label = document.createElement("h2"); label.textContent = I18N.t(turn.role === "user" ? "任务请求" : "助理回复");
      const text = document.createElement("div"); text.className = "shared-text"; text.setAttribute("data-i18n-skip", ""); text.textContent = turn.text || "";
      article.append(label, text); turns.appendChild(article);
    }
    const files = document.getElementById("shared-files");
    if (Array.isArray(data.files) && data.files.length) {
      files.hidden = false;
      for (const file of data.files) {
        const li = document.createElement("li"), link = document.createElement("a");
        link.href = base + "/file?path=" + encodeURIComponent(file.path); link.textContent = file.path; link.setAttribute("data-i18n-skip", ""); li.appendChild(link); files.querySelector("ul").appendChild(li);
      }
    }
    show("此页面只读，无法修改或继续执行任务");
  } catch { show("分享内容读取失败，请稍后重试"); }
})();
