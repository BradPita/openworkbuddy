// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 OpenWorkBuddy Contributors · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 设置 → 浏览器：把用户自己那个登录着的 Chrome 接给 OpenWorkBuddy。
 *
 * 三件事照顺序摆：装扩展 → 配对 → 看连没连上。
 *   - 桌面版一颗按钮直接在访达 / 资源管理器里打开扩展文件夹；服务器版给 zip 下载
 *   - 配对信息 = 这个页面的地址 + # + 配对码，扩展弹窗里一次粘进去，不用分两格抄
 *   - 状态按登录的这个人查：组织里各人配各人的，这一页只看得见自己那台
 *
 * 状态只在这一页开着、窗口在前台时轮询；关了设置、切走标签页就停。
 * 线本身见 src/core/ext/chrome-link.js，扩展在 extension/chrome/。
 */
let brTimer = 0;
let brWaitShown = false; // 切到后台时只挂一个「回来再查」，别每轮叠一个
const brPost = (url) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
  .then((r) => r.json().catch(() => ({ error: `HTTP ${r.status}` })))
  .catch((e) => ({ error: "请求没发出去：" + String((e && e.message) || e) }));

function renderBrowserPane(pane) {
  clearTimeout(brTimer);
  pane.insertAdjacentHTML("beforeend", `
    <div class="card-item">
      <div class="t">你的 Chrome</div>
      <div class="d">连上以后，它能在你的 Chrome 里开网页、读内容、点按钮。每一步都先问你。</div>
      <div style="display:flex;align-items:center;gap:10px;margin-top:10px;flex-wrap:wrap">
        <span class="im-st off" id="br-st"><i class="dot"></i><em>正在查…</em></span>
        <span class="d" id="br-who"></span>
        <button class="btn-plain" id="br-off" hidden>断开</button>
      </div>
      <div class="d" id="br-ver" style="margin-top:6px" hidden></div>
      <div class="d" style="margin-top:6px">密码、银行卡它不会替你填，chrome:// 开头的页面也不碰。</div>
    </div>
    <div class="card-item">
      <div class="t">第一步：装扩展</div>
      <ol class="d" style="margin:6px 0 8px;padding-left:20px;line-height:1.9">
        <li>在 Chrome 地址栏打开 <code>chrome://extensions</code></li>
        <li>打开右上角的「开发者模式」</li>
        <li>点「加载已解压的扩展程序」，选中扩展文件夹</li>
      </ol>
      <div id="br-get"></div>
    </div>
    <div class="card-item">
      <div class="t">第二步：配对</div>
      <div class="d">生成配对码，点 Chrome 右上角拼图里的 OpenWorkBuddy，把配对信息粘进去。</div>
      <div style="margin-top:8px">
        <button class="btn-brand" id="br-code">生成配对码</button>
      </div>
      <div id="br-pair" hidden style="margin-top:10px">
        <div class="f">配对信息</div>
        <div style="display:flex;gap:8px;align-items:center">
          <input id="br-pair-text" readonly style="flex:1;min-width:0">
          <button class="btn-plain" id="br-copy">复制</button>
        </div>
        <div class="d" style="margin-top:4px">十分钟内有效，用一次就作废。</div>
      </div>
    </div>
    <div class="card-item" id="br-proxy" hidden>
      <div class="t">服务器前面有 Nginx 的话</div>
      <div class="d">扩展靠长连接连进来，反代那段要加上这三行：</div>
      <pre style="margin:6px 0 0;padding:8px 10px;border-radius:8px;background:var(--owb-bg-2, rgba(127,127,127,.08));font-size:12px;overflow:auto">proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";</pre>
    </div>`);
  if (typeof mountBrowserRecording === "function") mountBrowserRecording(pane);
  const $ = (sel) => pane.querySelector(sel);
  let drewGet = false;
  let waitingPair = false;

  const drawGet = (d) => {
    if (drewGet) return;
    drewGet = true;
    const box = $("#br-get");
    if (d.can_open_folder) {
      box.innerHTML = `<button class="btn-plain" id="br-open">打开扩展文件夹</button>
        <div id="br-path-row" hidden style="display:flex;gap:8px;align-items:center;margin-top:8px">
          <code id="br-path" style="flex:1;min-width:0;word-break:break-all;font-size:12px"></code>
          <button class="btn-plain" id="br-path-copy">复制路径</button>
        </div>`;
      $("#br-open").onclick = async (e) => {
        e.target.disabled = true;
        const r = await brPost("/api/browser/open-folder");
        e.target.disabled = false;
        if (r.path) { $("#br-path").textContent = r.path; $("#br-path-row").hidden = false; }
        if (!r.ok) toast(r.error || "文件夹没打开，照着下面的路径自己找一下", "circle-x");
      };
      $("#br-path-copy").onclick = async () => {
        toast((await copyText($("#br-path").textContent)) ? "路径复制好了" : "没复制上，手动选中复制一下", "copy");
      };
    } else {
      box.innerHTML = `<a class="btn-plain" href="/api/browser/extension.zip" download style="display:inline-flex;align-items:center;text-decoration:none">下载扩展</a>
        <div class="d" style="margin-top:6px">下载后先解压，选中解压出来的那个文件夹。</div>`;
    }
    $("#br-proxy").hidden = !!d.desktop;
  };

  const paint = (d) => {
    const chip = $("#br-st");
    const [cls, text] = !d || d.error ? ["err", "查不到连接状态，刷新一下试试"]
      : !d.serving ? ["err", "这个服务现在接不了 Chrome，重启一下再试"]
      : d.connected ? ["ok", "已连上 Chrome"]
      : d.paired ? ["warn", "配对过，但 Chrome 现在没连着"]
      : ["off", "还没配对"];
    chip.className = "im-st " + cls;
    chip.querySelector("em").textContent = text;
    $("#br-who").textContent = d && d.connected && d.name ? d.name : "";
    $("#br-off").hidden = !(d && d.paired);
    // 扩展是上一版留下的：Chrome 不会自己换，得用户在扩展页点一下刷新
    const old = !!(d && d.connected && d.version && d.bundled_version && d.version !== d.bundled_version);
    $("#br-ver").hidden = !old;
    if (old) {
      $("#br-ver").textContent = d.can_open_folder
        ? "扩展是旧版的：再点一次「打开扩展文件夹」，然后在扩展页点刷新"
        : "扩展是旧版的：重新下载解压，覆盖原来的文件夹，再到扩展页点刷新";
    }
    if (d && !d.error) drawGet(d);
    if (waitingPair && d && d.connected) {
      waitingPair = false;
      $("#br-pair").hidden = true;
      $("#br-code").textContent = "生成配对码";
      toast("Chrome 连上了", "circle-check");
    }
  };

  const poll = async () => {
    clearTimeout(brTimer);
    if (!pane.isConnected) return;
    const d = await fetch("/api/browser/status").then((r) => r.json()).catch(() => null);
    if (!pane.isConnected) return;
    paint(d);
    // 等配对那几分钟勤快点，平时慢慢看；切到后台就不查了，回来再接上
    if (document.visibilityState === "visible") brTimer = setTimeout(poll, waitingPair ? 1500 : 5000);
    else if (!brWaitShown) {
      brWaitShown = true;
      document.addEventListener("visibilitychange", () => { brWaitShown = false; if (pane.isConnected) poll(); }, { once: true });
    }
  };

  $("#br-code").onclick = async (e) => {
    e.target.disabled = true;
    const r = await brPost("/api/browser/pair-code");
    e.target.disabled = false;
    if (!r.code) { toast(r.error || "配对码没生成出来，再点一次试试", "circle-x"); return; }
    $("#br-pair-text").value = location.origin + "#" + r.code;
    $("#br-pair").hidden = false;
    e.target.textContent = "换一个配对码";
    waitingPair = true;
    poll();
  };
  $("#br-copy").onclick = async () => {
    toast((await copyText($("#br-pair-text").value)) ? "配对信息复制好了，去扩展里粘贴" : "没复制上，手动选中复制一下", "copy");
  };
  $("#br-pair-text").onfocus = (e) => e.target.select();
  $("#br-off").onclick = async (e) => {
    e.target.disabled = true;
    const r = await brPost("/api/browser/disconnect");
    e.target.disabled = false;
    if (r.error) toast(r.error, "circle-x");
    else toast("断开了，那边的配对也作废了", "circle-check");
    poll();
  };
  return poll();
}
