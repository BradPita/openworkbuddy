// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 OpenWorkBuddy Contributors · 商业使用需授权：COMMERCIAL-LICENSE.md
/**
 * 扩展弹窗：填地址和配对码、看连没连上、断开。
 * 「配对信息」那一整段（地址#配对码）粘进配对码框也认，省得两个框分别抄。
 */
"use strict";

const ZH = /^zh/i.test(navigator.language || "");
const T = {
  addr: ["OpenWorkBuddy 的地址", "OpenWorkBuddy address"],
  code: ["配对码", "Pairing code"],
  codePh: ["设置 → 浏览器 里生成", "Get one in Settings → Browser"],
  go: ["配对", "Pair"],
  retry: ["重新连接", "Reconnect"],
  unpair: ["断开", "Disconnect"],
  idle: ["还没配对", "Not paired yet"],
  connecting: ["正在连接…", "Connecting…"],
  online: ["已连上 OpenWorkBuddy", "Connected to OpenWorkBuddy"],
  error: ["没连上", "Not connected"],
  who: ["账号：{owner}　地址：{addr}", "Account: {owner} · Address: {addr}"],
  where: ["要连的是：{host}", "Will connect to: {host}"],
  remote: ["不是本机地址：确认这是你自己的 OpenWorkBuddy", "Not this computer: make sure it's your own OpenWorkBuddy"],
  badAddr: ["地址看不懂：要像 http://127.0.0.1:3800 这样", "Can't read that address. Try http://127.0.0.1:3800"],
  pairing: ["配对中…", "Pairing…"],
  noReply: ["后台没回话，关掉弹窗再打开试试", "No reply from the extension. Close and reopen this popup."],
};
const t = (k, vars = {}) => String((T[k] || [k, k])[ZH ? 0 : 1]).replace(/\{(\w+)\}/g, (_, v) => vars[v] ?? "");
const $ = (id) => document.getElementById(id);
const LOOP = new Set(["127.0.0.1", "localhost", "[::1]"]);

for (const el of document.querySelectorAll("[data-t]")) el.textContent = t(el.dataset.t);
for (const el of document.querySelectorAll("[data-ph]")) el.placeholder = t(el.dataset.ph);
document.documentElement.lang = ZH ? "zh-CN" : "en";

function ask(msg) {
  return chrome.runtime.sendMessage(msg).then((r) => r || { ok: false, error: t("noReply") }, () => ({ ok: false, error: t("noReply") }));
}

function showErr(text) {
  $("err").textContent = text || "";
  $("err").hidden = !text;
}

/** 地址规整成 http(s)://主机[:端口]；看不懂回空 */
function normAddr(s) {
  let v = String(s || "").trim();
  if (!v) return "";
  if (!/^[a-z]+:\/\//i.test(v)) v = "http://" + v;
  try { const u = new URL(v); return u.protocol === "http:" || u.protocol === "https:" ? u.origin : ""; } catch { return ""; }
}

function showWhere() {
  const a = normAddr($("addr").value || $("addr").placeholder);
  const el = $("where");
  if (!a) { el.textContent = t("badAddr"); el.className = "note warn"; return; }
  const u = new URL(a);
  const remote = !LOOP.has(u.hostname);
  el.textContent = t("where", { host: u.host }) + (remote ? (ZH ? "。" : ". ") + t("remote") : "");
  el.className = remote ? "note warn" : "note";
}

function render(s) {
  const st = s.state || "idle";
  $("dot").className = "dot " + st;
  $("state").textContent = t(st);
  const linked = !!s.paired;
  $("pair").hidden = linked;
  $("linked").hidden = !linked;
  if (linked) $("who").textContent = t("who", { owner: s.owner || "?", addr: s.addr || "" });
  else if (!$("addr").value && s.addr) $("addr").value = s.addr;
  showErr(st === "online" ? "" : s.error);
  showWhere();
}

async function refresh() {
  render(await ask({ type: "status" }));
}

/** 整段「地址#配对码」粘进来：拆开分别放 */
function splitPasted() {
  const v = $("code").value.trim();
  const i = v.lastIndexOf("#");
  if (i > 0) {
    $("addr").value = v.slice(0, i);
    $("code").value = v.slice(i + 1);
    showWhere();
  }
}

async function pair() {
  splitPasted();
  const addr = normAddr($("addr").value || $("addr").placeholder);
  if (!addr) return showErr(t("badAddr"));
  $("go").disabled = true;
  $("go").textContent = t("pairing");
  showErr("");
  const r = await ask({ type: "pair", addr, code: $("code").value });
  $("go").disabled = false;
  $("go").textContent = t("go");
  if (!r.ok) showErr(r.error);
  else $("code").value = "";
  await refresh();
}

$("go").addEventListener("click", pair);
$("code").addEventListener("paste", () => setTimeout(splitPasted, 0));
$("addr").addEventListener("input", showWhere);
for (const id of ["addr", "code"]) {
  $(id).addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); pair(); }
  });
}
$("retry").addEventListener("click", async () => { render(await ask({ type: "reconnect" })); });
$("unpair").addEventListener("click", async () => { await ask({ type: "unpair" }); await refresh(); });

refresh();
setInterval(refresh, 1500);
