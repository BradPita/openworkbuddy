// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
// ================= 模板里的填空：写的时候怎么挖、用的时候怎么填 =================
/*
 * 模板正文里的 __占位__ 以前只有一种用法：填进输入框时选中第一个，剩下的自己在几百字里找、
 * 自己删下划线、自己打。写模板的人也得手敲两对下划线。
 *
 * 现在一个空就是一格：
 *   · 用：点「填进输入框」先弹一张小表，每个空一格，右边看着拼好的样子；同名的空填一次处处生效。
 *     表里没填的照原样留着，到了输入框按 Tab 一个个跳过去；
 *   · 写：选中要换的字点「设为填空」，下划线自己加上；下面列出这条一共几个空，点一下跳过去。
 *
 * 写法（老模板一个字不用改，照样认）：
 *   __产品名__               一行字
 *   __页数=10__              带默认值，表里预先填好
 *   __图表=折线/柱状/饼图__   几个选项点着选，默认第一个；没写名字（__折线/柱状__）就叫「选一个」
 *   __任务描述，越具体越好__  第一个逗号/冒号/括号前是名字，后面是格子里的灰字提示
 *   __粘贴记录__ __…__        名字像「粘贴 / 描述 / 记录 / 原文 / 内容 / 进展」或干脆没写的，给一个多行框
 *   __10__                   只有数字：老模板的写法，当成默认值
 *
 * 上半截是纯函数（test/tpl-blanks.js 把整个文件丢进空的 vm 里跑、直接验），下半截才碰页面。
 * 跟 app-01-attention.js 一样不写 module.exports：写了 tsc 就把它当 CommonJS 模块，顶层名字不再算全局。
 */

/** 跟 startTaskWith 原来那条一个口径：两对下划线中间不带下划线、不跨行 */
const BLANK_RE = /__([^_\n]*)__/g;
/** 一个选项最长几个字。再长就不像选项了，像一句「工作区里的 XX 文件 / 下面这段内容」 */
const BLANK_OPT_MAX = 8;
/** 没写名字时的兜底叫法 */
const BLANK_AUTO = ["选一个", "数字", "补充内容"];
const BLANK_LONG = /粘贴|描述|记录|原文|内容|进展|要做什么/;

/**
 * 一个空的原文（下划线中间那段）→ 表里那一格长什么样。
 * @returns {{raw:string, label:string, hint:string, kind:"text"|"long"|"pick"|"num", options:string[], def:string}}
 */
function blankSpec(raw) {
  const s = String(raw == null ? "" : raw).trim();
  let name = s, value = "";
  const eq = s.indexOf("=");
  if (eq > 0) { name = s.slice(0, eq).trim(); value = s.slice(eq + 1).trim(); }
  else if (eq === 0) { name = ""; value = s.slice(1).trim(); }
  const optsOf = (v) => {
    const parts = v.split("/").map((x) => x.trim());
    return parts.length >= 2 && parts.every((x) => x && x.length <= BLANK_OPT_MAX && !/\s/.test(x)) ? parts : null;
  };
  // 没有 = 的时候，整段像选项或像数字，就当值用
  if (eq < 0 && (optsOf(s) || /^\d+(\.\d+)?$/.test(s))) { name = ""; value = s; }
  let label = name, hint = "";
  const cut = name.search(/[，,：:（(]/);
  if (cut > 0) { label = name.slice(0, cut).trim(); hint = name.slice(cut + 1).replace(/[）)]\s*$/, "").trim(); }
  if (/^[….·\s]*$/.test(label)) label = "";    // 老模板里的 __…__：没名字
  const options = value ? optsOf(value) : null;
  if (options) return { raw: s, label: label || "选一个", hint, kind: "pick", options, def: options[0] };
  if (value && /^\d+(\.\d+)?$/.test(value)) return { raw: s, label: label || "数字", hint, kind: "num", options: [], def: value };
  const long = !label || BLANK_LONG.test(label);
  return { raw: s, label: label || "补充内容", hint, kind: long ? "long" : "text", options: [], def: value };
}

/** 正文里的空，按第一次出现的顺序；原文一样的算同一个空 */
function blankFields(text) {
  const out = [], seen = new Set();
  for (const m of String(text || "").matchAll(BLANK_RE)) {
    const k = m[1].trim();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(blankSpec(m[1]));
  }
  return out;
}

/**
 * 按表里的值把空换掉。values 按 raw 认；空着的（只有空白的也算）原样留下 __原文__，
 * 好让人到输入框里接着按 Tab 填。
 */
function blankFill(text, values) {
  const v = values || {};
  return String(text || "").replace(BLANK_RE, (all, raw) => {
    const x = v[raw.trim()];
    return x != null && String(x).trim() ? String(x) : all;
  });
}

/** 还剩几个空没填（同名的算一个） */
function blankLeft(text) { return blankFields(text).length; }

/**
 * 输入框里按 Tab：从 from 往后（back 时往前）找下一个空，到头绕回来。
 * 光标正选着一个空时从它后面找，不然连按 Tab 永远停在同一个上。
 * @returns {[number, number] | null} 选区起止；一个空都没有给 null
 */
function blankNext(text, selStart, selEnd, back) {
  const all = [...String(text || "").matchAll(BLANK_RE)].map((m) => [m.index, m.index + m[0].length]);
  if (!all.length) return null;
  if (back) {
    for (let i = all.length - 1; i >= 0; i--) if (all[i][1] <= selStart && !(all[i][0] === selStart && all[i][1] === selEnd)) return all[i];
    return all[all.length - 1];
  }
  for (const r of all) if (r[0] >= selEnd || (r[0] >= selStart && r[1] > selEnd)) {
    if (r[0] === selStart && r[1] === selEnd) continue;
    return r;
  }
  return all[0];
}

/**
 * 编辑框里的「设为填空」。
 *   · 选中了一段字 → 两头加下划线（字里本来的下划线去掉，不然拆成两个空）；
 *   · 光标落在一个空里面（或正好选着它） → 去掉下划线，变回普通字，再点一次就是撤销；
 *   · 什么都没选 → 插一个 __填空__，选中「填空」两个字，接着打名字就行。
 * @returns {{text:string, start:number, end:number}} 新正文和之后该选中的范围
 */
function blankToggle(text, selStart, selEnd) {
  const s = String(text || "");
  const a = Math.max(0, Math.min(selStart, selEnd)), b = Math.min(s.length, Math.max(selStart, selEnd));
  for (const m of s.matchAll(BLANK_RE)) {
    const st = m.index, en = st + m[0].length;
    if (a >= st && b <= en && !(a === b && (a === st || a === en))) {
      const inner = m[1];
      return { text: s.slice(0, st) + inner + s.slice(en), start: st, end: st + inner.length };
    }
  }
  if (a === b) {
    const ins = "__填空__";
    return { text: s.slice(0, a) + ins + s.slice(a), start: a + 2, end: a + 2 + 2 };
  }
  // 选区两头的空白留在外面：「 产品名 」选多了一格空格，不该变成「__ 产品名 __」
  let x = a, y = b;
  while (x < y && /\s/.test(s[x])) x++;
  while (y > x && /\s/.test(s[y - 1])) y--;
  const inner = s.slice(x, y).replace(/_/g, "").replace(/\n+/g, " ");
  if (!inner) return { text: s, start: a, end: b };
  return { text: s.slice(0, x) + "__" + inner + "__" + s.slice(y), start: x + 2, end: x + 2 + inner.length };
}

// ———————————————— 下半截：页面 ————————————————

/** 上次在这条模板里填的值，下次打开预先填上。只是个方便，读不到就当没填过 */
function blankMemo(id, values) {
  const k = "owb-tplfill:" + id;
  try {
    if (values === undefined) return JSON.parse(localStorage.getItem(k) || "{}") || {};
    localStorage.setItem(k, JSON.stringify(values));
  } catch {}
  return {};
}

/**
 * 用模板：有空就先弹一张表，填完（或跳过）再进输入框；没有空直接进。
 * o.preview = 编辑框里「试填一下」：只给看，不进输入框。
 * @param {{id?:string, t?:string, p:string}} t
 */
async function useTplWithBlanks(t, o = {}) {
  const fields = blankFields(t.p);
  if (!fields.length) { if (!o.preview) startTaskWith(t.p); return; }
  const text = await openBlankSheet(t, fields, o);
  if (text == null || o.preview) return;
  startTaskWith(text);
  const left = blankLeft(text);
  if (left) toast(`还有 ${left} 个空，按 Tab 跳到下一个`, "info");
}

function openBlankSheet(t, fields, o) {
  const memo = t.id && !o.preview ? blankMemo(t.id) : {};
  const vals = {};
  for (const f of fields) vals[f.raw] = memo[f.raw] != null ? String(memo[f.raw]) : f.def;
  return new Promise((resolve) => {
    const prev = document.activeElement;
    const wrap = document.createElement("div");
    wrap.className = "ask-mask";
    const title = o.preview ? "试填一下" : "填几个空";
    wrap.innerHTML =
      `<div class="ask-box tpl-fill" role="dialog" aria-modal="true" aria-label="${esc(title)}">` +
      `<div class="ask-t">${esc(title)}<span class="tpl-fill-of" translate="no">${esc(t.t || "")}</span></div>` +
      `<div class="tpl-fill-body"><div class="tpl-fill-fs"></div><pre class="tpl-fill-pv" aria-live="off"></pre></div>` +
      `<div class="ask-ops">` +
      (o.preview ? `<button type="button" class="btn-brand ask-ok">看完了</button>`
        : `<span class="tpl-fill-tip"></span><button type="button" class="btn-plain ask-no">取消</button>` +
          `<button type="button" class="btn-plain tpl-fill-raw">空着填进去</button>` +
          `<button type="button" class="btn-brand ask-ok">填进输入框</button>`) +
      `</div></div>`;
    document.body.appendChild(wrap);
    const fs = wrap.querySelector(".tpl-fill-fs");
    const pv = wrap.querySelector(".tpl-fill-pv");
    fs.innerHTML = fields.map((f, i) => {
      const id = `tpl-fill-${i}`;
      // 名字是写模板的人起的，切英文也别撞词典；没起名时那几个兜底叫法是我们的字，照常翻
      const own = BLANK_AUTO.includes(f.label) ? "" : ' translate="no"';
      const lab = `<label class="tpl-fill-lb" for="${id}"><span${own}>${esc(f.label)}</span></label>`;
      if (f.kind === "pick") {
        return `<div class="tpl-fill-f" data-i="${i}">${lab}<div class="tpl-fill-picks" role="radiogroup">${f.options.map((x) =>
          `<button type="button" class="tpl-fill-pk" role="radio" data-v="${esc(x)}" translate="no">${esc(x)}</button>`).join("")}</div>` +
          `<input id="${id}" class="ask-in tpl-fill-in" data-i="${i}" autocomplete="off" placeholder="或者自己写"></div>`;
      }
      const ph = f.hint || "";
      return `<div class="tpl-fill-f" data-i="${i}">${lab}` + (f.kind === "long"
        ? `<textarea id="${id}" class="tpl-fill-in tpl-fill-ta" data-i="${i}" rows="3" placeholder="${esc(ph)}"></textarea>`
        : `<input id="${id}" class="ask-in tpl-fill-in" data-i="${i}" autocomplete="off"${f.kind === "num" ? ' inputmode="decimal"' : ""} placeholder="${esc(ph)}">`) +
        `</div>`;
    }).join("");
    const inputs = [...fs.querySelectorAll(".tpl-fill-in")];
    const paint = () => {
      // 预览：填了的高亮成填进去的字，没填的留着空的样子；整段用文本节点拼，不拼 HTML
      pv.textContent = "";
      const src = String(t.p);
      let at = 0;
      for (const m of src.matchAll(BLANK_RE)) {
        pv.appendChild(document.createTextNode(src.slice(at, m.index)));
        const v = vals[m[1].trim()];
        const mk = document.createElement("mark");
        const filled = v != null && String(v).trim();
        mk.className = filled ? "on" : "";
        mk.textContent = filled ? String(v) : m[1].trim() ? blankSpec(m[1]).label : "…";
        pv.appendChild(mk);
        at = m.index + m[0].length;
      }
      pv.appendChild(document.createTextNode(src.slice(at)));
      fs.querySelectorAll(".tpl-fill-f").forEach((el) => {
        const f = fields[+el.dataset.i];
        el.querySelectorAll(".tpl-fill-pk").forEach((b) => {
          const on = b.dataset.v === vals[f.raw];
          b.classList.toggle("on", on);
          b.setAttribute("aria-checked", on ? "true" : "false");
        });
      });
      const tip = wrap.querySelector(".tpl-fill-tip");
      if (tip) {
        const left = fields.filter((f) => !String(vals[f.raw] || "").trim()).length;
        tip.textContent = left ? `还空着 ${left} 个，进了输入框按 Tab 接着填` : "";
      }
    };
    inputs.forEach((el) => {
      const f = fields[+el.dataset.i];
      // 选项那一格的输入框只放「自己写的」：点着选的值不往里抄，不然点一下选项框里就多出一串字
      el.value = f.kind === "pick" && f.options.includes(vals[f.raw]) ? "" : vals[f.raw] || "";
      el.oninput = () => {
        if (f.kind === "pick" && !el.value.trim()) vals[f.raw] = f.def; else vals[f.raw] = el.value;
        paint();
      };
    });
    fs.querySelectorAll(".tpl-fill-f").forEach((el) => {
      const f = fields[+el.dataset.i];
      el.querySelectorAll(".tpl-fill-pk").forEach((b) => b.onclick = () => {
        vals[f.raw] = b.dataset.v;
        const own = el.querySelector(".tpl-fill-in");
        if (own) own.value = "";
        paint();
      });
    });
    function done(val) {
      document.removeEventListener("keydown", onKey, true);
      wrap.remove();
      try { if (val == null && prev && prev.isConnected && prev.focus) prev.focus(); } catch {}
      resolve(val);
    }
    const go = (raw) => {
      if (o.preview) return done(null);
      if (t.id) blankMemo(t.id, vals);
      done(raw ? String(t.p) : blankFill(t.p, vals));
    };
    function onKey(e) {
      if (imeKey(e)) return;
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(null); }
      else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.stopPropagation(); go(false); }
      else if (e.key === "Enter" && !e.shiftKey && e.target && e.target.tagName === "INPUT") {
        // 单行格里回车 = 下一格；最后一格回车 = 填进去。多行框里回车照常换行
        e.preventDefault(); e.stopPropagation();
        const i = inputs.indexOf(/** @type {any} */ (e.target));
        if (i >= 0 && i < inputs.length - 1) inputs[i + 1].focus(); else go(false);
      }
    }
    wrap.querySelector(".ask-ok").onclick = () => go(false);
    const raw = wrap.querySelector(".tpl-fill-raw");
    if (raw) /** @type {HTMLElement} */ (raw).onclick = () => go(true);
    const no = wrap.querySelector(".ask-no");
    if (no) /** @type {HTMLElement} */ (no).onclick = () => done(null);
    wrap.onmousedown = (e) => { if (e.target === wrap) done(null); };
    document.addEventListener("keydown", onKey, true);
    paint();
    const first = inputs.find((el) => !el.value) || inputs[0];
    if (first) first.focus();
  });
}

/**
 * 编辑框里提示词那一格的两件小工具：「设为填空」按钮（和 ⌘/Ctrl+E），下面一排这条有哪些空。
 * ta 是提示词那个 textarea，onChange 在正文被改过之后调（编辑框拿它重算「改过没有」）。
 */
function bindBlankTools(box, ta, onChange) {
  const btn = box.querySelector(".tpl-mk");
  const list = box.querySelector(".tpl-blanks");
  const toggle = () => {
    const r = blankToggle(ta.value, ta.selectionStart, ta.selectionEnd);
    if (r.text === ta.value) return;
    ta.focus();
    // 走 execCommand：撤销（⌘Z）还能退回去；不支持时直接改值
    ta.setSelectionRange(0, ta.value.length);
    let ok = false;
    try { ok = document.execCommand("insertText", false, r.text); } catch {}
    if (!ok || ta.value !== r.text) ta.value = r.text;
    ta.setSelectionRange(r.start, r.end);
    onChange();
  };
  const paint = () => {
    const fs = blankFields(ta.value);
    list.innerHTML = fs.length
      ? `<span class="tpl-blanks-n">${esc(`${fs.length} 个空`)}</span>` + fs.map((f, i) =>
        `<button type="button" class="tpl-blank" data-i="${i}" translate="no">${esc(f.label)}${f.kind === "pick" ? `<span class="k">${esc(f.options.join("/"))}</span>` : f.def ? `<span class="k">${esc(f.def)}</span>` : ""}</button>`).join("") +
        `<button type="button" class="btn-plain tpl-try">试填一下</button>`
      : `<span class="tpl-blanks-n">还没有空：选中要换的字，点「设为填空」</span>`;
    list.querySelectorAll(".tpl-blank").forEach((b) => b.onclick = () => {
      const f = fs[+b.dataset.i];
      const at = ta.value.indexOf("__" + f.raw);
      const m = at >= 0 ? /__[^_\n]*__/.exec(ta.value.slice(at)) : null;
      ta.focus();
      if (m) ta.setSelectionRange(at + 2, at + m[0].length - 2);
    });
    const tr = list.querySelector(".tpl-try");
    if (tr) /** @type {HTMLElement} */ (tr).onclick = () => {
      const title = /** @type {HTMLInputElement|null} */ (box.querySelector('[data-k="t"]'));
      useTplWithBlanks({ t: title ? title.value : "", p: ta.value }, { preview: true });
    };
  };
  btn.onclick = toggle;
  ta.addEventListener("keydown", (e) => {
    if (imeKey(e)) return;
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && (e.key === "e" || e.key === "E")) { e.preventDefault(); toggle(); }
  });
  ta.addEventListener("input", paint);
  return paint;
}

/**
 * 输入框里按 Tab 跳到下一个空（Shift+Tab 上一个）。正文里一个空都没有时 Tab 照旧，不抢焦点切换。
 * @ 菜单开着时 Tab 归它挑技能：那边挂在 app-01 里、比这儿先挂，拿走之后 stopImmediatePropagation，
 * 这儿就收不到。所以这里也挂冒泡阶段，挂成捕获就抢在它前面了。
 */
function bindBlankTab(el) {
  el.addEventListener("keydown", (e) => {
    if (e.key !== "Tab" || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || imeKey(e)) return;
    const r = blankNext(el.value, el.selectionStart, el.selectionEnd, e.shiftKey);
    if (!r) return;
    e.preventDefault();
    el.setSelectionRange(r[0], r[1]);
  });
}
if (typeof inputEl !== "undefined" && inputEl) bindBlankTab(inputEl);
