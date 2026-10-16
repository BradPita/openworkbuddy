// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 OpenWorkBuddy Contributors · 商业使用需授权：COMMERCIAL-LICENSE.md
/**
 * 注进网页里跑的那一半：读正文、列能点能填的元素、点、输入、滚动、找东西。
 * 跑在扩展自己的隔离环境里（chrome.scripting.executeScript），网页自己的脚本看不见、也改不了这里的东西。
 * background.js 也会 importScripts 它，只用不碰页面的 blockedUrl / sensitiveWhy。
 *
 * 同一个页面会被反复注入：整份包在一个函数里，不留顶层 const/let（第二次注入会报重复声明）。
 *   - 输入框里已经填的内容一律不往回读
 *   - 密码、银行卡、证件、验证码这类框不填，动手前在页面里再核一遍
 *   - 每一步先核对页面还是批准时那个网站（expectOrigin），对不上就不做
 */
(function () {
  "use strict";

  const LOOP = ["127.0.0.1", "localhost", "[::1]", "::1"];
  const portOf = (u) => u.port || (u.protocol === "https:" ? "443" : "80");

  /** 跟服务端 src/tools/chrome.js 的 blockedUrl 同一套：两边各拦一次 */
  function blockedUrl(url, serverAddr) {
    let u;
    try { u = new URL(String(url)); } catch { return "网址看不懂"; }
    if (u.protocol !== "http:" && u.protocol !== "https:") return "浏览器内部页面、本机文件、扩展页，OpenWorkBuddy 都不碰";
    const h = u.hostname.toLowerCase();
    if (h === "chromewebstore.google.com" || (h === "chrome.google.com" && /^\/webstore/.test(u.pathname))) return "扩展商店 OpenWorkBuddy 不碰";
    if (serverAddr) {
      let o = null;
      try { o = new URL(String(serverAddr)); } catch {}
      if (o) {
        const oh = o.hostname.toLowerCase();
        // 地址里没写端口（反向代理后面）：按域名算；写了端口：本机的几种写法算一个
        const same = !o.port ? oh === h : portOf(o) === portOf(u) && (oh === h || (LOOP.includes(oh) && LOOP.includes(h)));
        if (same) return "这是 OpenWorkBuddy 自己的页面，不在这里动它";
      }
    }
    return "";
  }

  /** 这个框是不是密码、银行卡、证件、验证码类：是就回一个说法，不是回空 */
  function sensitiveWhy(a) {
    const x = a || {};
    const type = String(x.type || "").toLowerCase();
    const ac = String(x.autocomplete || "").toLowerCase();
    if (type === "password" || /\b(current|new)-password\b/.test(ac)) return "密码框";
    if (/\bcc-/.test(ac)) return "银行卡信息";
    if (/\bone-time-code\b/.test(ac)) return "验证码";
    const words = [x.name, x.id, x.placeholder, x.aria, x.label].map((s) => String(s || "")).join(" ");
    if (/passw|pwd|passcode|密码|口令/i.test(words)) return "密码框";
    if (/card.?(no|num)|cardnumber|credit|debit|cvv|cvc|\bcsc\b|security.?code|expir|iban|routing|swift|bank.?account|account.?num|卡号|信用卡|银行|安全码|有效期/i.test(words)) return "银行卡信息";
    if (/身份证|证件|护照|\bssn\b|social.?security|passport|national.?id/i.test(words)) return "证件号";
    if (/验证码|校验码|\botp\b|one.?time/i.test(words)) return "验证码";
    return "";
  }

  // ── 以下只在网页里用 ──

  const SEL = [
    "a[href]", "button", "input:not([type=hidden])", "textarea", "select", "summary",
    "[role=button]", "[role=link]", "[role=checkbox]", "[role=radio]", "[role=switch]", "[role=tab]", "[role=menuitem]", "[role=option]",
    "[contenteditable='']", "[contenteditable=true]", "[onclick]",
  ].join(",");
  const CAP = 150;
  const TEXT_TYPES = ["", "text", "search", "email", "url", "tel", "number"];

  function refs() {
    if (!globalThis.__owbRefs) globalThis.__owbRefs = { byRef: new Map(), byEl: new WeakMap(), n: 0 };
    return globalThis.__owbRefs;
  }
  function refOf(el) {
    const R = refs();
    let r = R.byEl.get(el);
    if (!r) {
      if (R.byRef.size > 5000) for (const [k, v] of R.byRef) if (!v.isConnected) R.byRef.delete(k);
      r = "e" + ++R.n;
      R.byEl.set(el, r);
      R.byRef.set(r, el);
    }
    return r;
  }
  const norm = (s, n = 80) => String(s || "").replace(/\s+/g, " ").trim().slice(0, n);

  function visible(el) {
    if (!el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 && r.height < 1) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none";
  }
  function labelText(el) {
    const out = [];
    if (el.labels) for (const l of el.labels) out.push(l.innerText || l.textContent || "");
    const ids = String(el.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean);
    for (const id of ids) { const n = document.getElementById(id); if (n) out.push(n.innerText || n.textContent || ""); }
    return norm(out.join(" "));
  }
  const isField = (el) => el.tagName === "INPUT" || el.tagName === "TEXTAREA";

  function kindOf(el) {
    const tag = el.tagName.toLowerCase();
    const role = String(el.getAttribute("role") || "").toLowerCase();
    if (tag === "a") return "link";
    if (tag === "textarea") return "textarea";
    if (tag === "select") return "select";
    if (tag === "input") {
      const t = String(el.type || "text").toLowerCase();
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      if (["submit", "button", "reset", "image"].includes(t)) return "button";
      return "input";
    }
    if (el.isContentEditable && tag !== "button") return "editable";
    if (role === "link") return "link";
    if (role === "checkbox" || role === "switch") return "checkbox";
    if (role === "radio") return "radio";
    return "button";
  }
  function nameOf(el) {
    const aria = el.getAttribute("aria-label");
    if (aria) return norm(aria);
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") {
      const t = String(el.type || "").toLowerCase();
      if (el.tagName === "INPUT" && ["submit", "button", "reset"].includes(t)) return norm(el.value || t); // 按钮上的字，不是用户填的
      return norm(labelText(el) || el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("name") || "");
    }
    const lab = labelText(el);
    if (lab) return lab;
    const txt = norm(el.innerText || el.textContent || "");
    if (txt) return txt;
    const img = el.querySelector && el.querySelector("img[alt]");
    return norm((img && img.getAttribute("alt")) || el.getAttribute("title") || "");
  }
  function editable(el) {
    if (el.disabled || el.readOnly) return false;
    if (el.tagName === "TEXTAREA") return true;
    if (el.tagName === "SELECT") return !el.multiple;
    if (el.tagName === "INPUT") return TEXT_TYPES.includes(String(el.getAttribute("type") || "").toLowerCase()) || TEXT_TYPES.includes(String(el.type || "").toLowerCase());
    return !!el.isContentEditable;
  }
  function sensitiveOf(el) {
    return sensitiveWhy({
      type: el.getAttribute("type") || "", autocomplete: el.getAttribute("autocomplete"), name: el.getAttribute("name"),
      id: el.id, placeholder: el.getAttribute("placeholder"), aria: el.getAttribute("aria-label"), label: labelText(el),
    });
  }
  function describe(el) {
    const kind = kindOf(el);
    const d = { ref: refOf(el), kind, name: nameOf(el) };
    if (kind === "link" && /^https?:/i.test(String(el.href || ""))) d.href = String(el.href).slice(0, 300);
    if (["input", "textarea", "editable"].includes(kind)) { const why = sensitiveOf(el); if (why) d.sensitive = why; }
    if (el.disabled || el.getAttribute("aria-disabled") === "true") d.disabled = true;
    return d;
  }

  /** 能点能填的：看得见的，眼前（往下一屏以内）的排前面，最多列 CAP 个 */
  function listElements() {
    const near = [];
    const far = [];
    const vh = innerHeight;
    for (const el of document.querySelectorAll(SEL)) {
      if (!isField(el) && el.parentElement && el.parentElement.closest("a[href],button")) continue; // 按钮里套的小东西不重复列
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      (r.bottom >= 0 && r.top <= vh * 2 ? near : far).push(el);
    }
    const all = near.concat(far);
    return { list: all.slice(0, CAP).map(describe), more: Math.max(0, all.length - CAP) };
  }

  function read(a) {
    const max = Math.min(20000, Math.max(200, Number(a.maxChars) || 8000));
    const raw = document.body ? document.body.innerText || "" : "";
    const text = raw.replace(/[ \t ]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    const els = listElements();
    return { url: location.href, title: document.title || "", text: text.slice(0, max), truncated: text.length > max, total: text.length, elements: els.list, more: els.more };
  }

  function byText(t) {
    const want = norm(t).toLowerCase();
    if (!want) return null;
    let best = null;
    let bestScore = 0;
    for (const el of document.querySelectorAll(SEL)) {
      if (!visible(el)) continue;
      const n = nameOf(el).toLowerCase();
      const score = !n ? 0 : n === want ? 3 : n.startsWith(want) ? 2 : n.includes(want) ? 1 : 0;
      if (score > bestScore) { best = el; bestScore = score; if (score === 3) break; }
    }
    return best;
  }

  /** 审批前看一眼：要点 / 要填的是哪个，只为把审批卡写清楚 */
  function resolve(a) {
    let el = null;
    let why = "";
    if (a.ref) {
      el = refs().byRef.get(String(a.ref)) || null;
      if (!el) why = `没有 ${a.ref} 这个编号`;
      else if (!el.isConnected) { el = null; why = `${a.ref} 已经不在页面上了，页面可能刷新过`; }
    } else if (a.selector) {
      try { el = document.querySelector(String(a.selector)); } catch { why = "selector 写得不对"; }
    } else if (a.text && !a.forType) {
      el = byText(String(a.text));
    }
    if (el && a.forType && !editable(el) && !isField(el)) el = el.querySelector("input,textarea,[contenteditable=''],[contenteditable=true]") || el;
    if (el && !a.forType && !el.matches(SEL)) el = el.closest(SEL) || el;
    if (!el) return { found: false, why };
    const d = describe(el);
    return { found: true, ref: d.ref, kind: d.kind, name: d.name, href: d.href || "", sensitive: d.sensitive || "", editable: editable(el), disabled: !!d.disabled, why: "" };
  }

  function fire(el, type, at) {
    const pointer = type.startsWith("pointer") && typeof PointerEvent === "function";
    const init = { bubbles: true, cancelable: true, composed: true, view: window, clientX: at.x, clientY: at.y, button: 0 };
    el.dispatchEvent(pointer ? new PointerEvent(type, { ...init, pointerType: "mouse", isPrimary: true }) : new MouseEvent(type, init));
  }

  function click(a) {
    const el = refs().byRef.get(String(a.ref || ""));
    if (!el || !el.isConnected) return { error: "要点的东西已经不在页面上了，先读一遍页面再说", code: "stale" };
    if (el.disabled) return { error: "这个按钮现在是灰的，点不了", code: "disabled" };
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    const r = el.getBoundingClientRect();
    const at = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    for (const t of ["pointerover", "pointerenter", "mouseover", "pointerdown", "mousedown"]) fire(el, t, at);
    if (typeof el.focus === "function") el.focus({ preventScroll: true });
    for (const t of ["pointerup", "mouseup"]) fire(el, t, at);
    if (typeof el.click === "function") el.click(); else fire(el, "click", at);
    return { clicked: true };
  }

  function pressEnter(el) {
    const key = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true };
    const go = el.dispatchEvent(new KeyboardEvent("keydown", key));
    el.dispatchEvent(new KeyboardEvent("keypress", key));
    el.dispatchEvent(new KeyboardEvent("keyup", key));
    // 网页自己接了回车（preventDefault）就不再替它提交表单，免得交两次
    const form = go && el.tagName === "INPUT" ? el.form : null;
    if (form) { if (typeof form.requestSubmit === "function") form.requestSubmit(); else form.submit(); }
  }

  function type(a) {
    const el = refs().byRef.get(String(a.ref || ""));
    if (!el || !el.isConnected) return { error: "要输入的框已经不在页面上了，先读一遍页面再说", code: "stale" };
    const why = sensitiveOf(el);
    if (why) return { error: `这个框是${why}，OpenWorkBuddy 不替你填，请你自己输入`, code: "sensitive" };
    if (!editable(el)) return { error: "这个框不能输入文字", code: "readonly" };
    const text = String(a.text == null ? "" : a.text);
    el.scrollIntoView({ block: "center", behavior: "instant" });
    el.focus({ preventScroll: true });
    if (el.tagName === "SELECT") {
      const matches = [...el.options].filter(option => !option.disabled && (option.value === text || option.textContent.trim() === text));
      if (matches.length !== 1) return { error: "没有唯一匹配的选项，请重新读取页面", code: "option" };
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(el, matches[0].value);
      el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true }));
    } else if (isField(el)) {
      // 走原生的 value 设置再发 input 事件：各种前端框架管着的输入框才认
      const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const set = Object.getOwnPropertyDescriptor(proto, "value").set;
      set.call(el, a.clear === false ? el.value + text : text);
      el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: text }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      const sel = getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      if (a.clear === false) range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
      if (a.clear !== false) document.execCommand("delete", false);
      document.execCommand("insertText", false, text);
    }
    if (a.submit) pressEnter(el);
    return { typed: text.length };
  }

  function scroller() {
    const doc = document.scrollingElement || document.documentElement;
    if (doc.scrollHeight > innerHeight + 4) return doc;
    // 整页不滚、里面某一块滚（聊天、邮箱这类）：挑看得见的最大那块
    let best = null;
    let area = 0;
    let n = 0;
    for (const el of document.querySelectorAll("body *")) {
      if (++n > 5000) break;
      if (el.scrollHeight <= el.clientHeight + 4) continue;
      const oy = getComputedStyle(el).overflowY;
      if (oy !== "auto" && oy !== "scroll" && oy !== "overlay") continue;
      const r = el.getBoundingClientRect();
      if (r.width * r.height > area) { best = el; area = r.width * r.height; }
    }
    return best || doc;
  }

  function scroll(a) {
    const s = scroller();
    const whole = s === (document.scrollingElement || document.documentElement);
    const vh = whole ? innerHeight : s.clientHeight;
    const amount = Math.min(20, Math.max(0.2, Number(a.amount) || 1));
    const dir = a.direction;
    const top = dir === "top" ? 0 : dir === "bottom" ? s.scrollHeight : s.scrollTop + (dir === "up" ? -1 : 1) * amount * vh * 0.85;
    s.scrollTo({ top, behavior: "instant" });
    return { y: Math.round(s.scrollTop), height: s.scrollHeight, viewport: vh, atEnd: s.scrollTop + vh >= s.scrollHeight - 2 };
  }

  function find(a) {
    if (a.selector) {
      let el = null;
      try { el = document.querySelector(String(a.selector)); } catch { throw new Error("selector 写得不对"); }
      return !!el && visible(el);
    }
    const t = norm(a.text, 500);
    return !!t && !!document.body && norm(document.body.innerText, 1e7).includes(t);
  }

  function run(cmd, args) {
    const a = args || {};
    try {
      if (a.expectOrigin && location.origin !== a.expectOrigin) return { error: `页面已经换成了 ${location.host || "别的地方"}，跟批准的不一样，这一步没做`, code: "moved" };
      switch (cmd) {
        case "read": return read(a);
        case "resolve": return resolve(a);
        case "click": return click(a);
        case "type": return type(a);
        case "scroll": return scroll(a);
        case "find": return { found: find(a) };
        default: return { error: "扩展不认识这一步，更新一下扩展再试", code: "unknown" };
      }
    } catch (e) {
      return { error: String((e && e.message) || e).slice(0, 300), code: "failed" };
    }
  }

  globalThis.OWBPage = { blockedUrl, sensitiveWhy, run };
})();
