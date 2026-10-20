// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 OpenWorkBuddy Contributors
"use strict";
/** 检查 HTML 内联脚本的语法和重复全局声明，不执行页面脚本。 */
const BROWSER_GLOBALS = ["window", "document", "location", "top"];
function inlineScriptErrors(src) {
  const vm = require("vm");
  const html = String(src || "");
  const out = [];
  let at = 0, line = 1, lines = null;
  const lineOf = (i) => { for (; at < i; at++) if (html.charCodeAt(at) === 10) line++; return line; };
  const scripts = [];
  const re = /<!--[\s\S]*?-->|<textarea\b[\s\S]*?<\/textarea\s*>|<script\b((?:"[^"]*"|'[^']*'|[^'">])*)>([\s\S]*?)<\/script\s*>/gi;
  for (const m of html.matchAll(re)) {
    const code = m[2];
    if (code === undefined || !code.trim() || /\{\{|\{%|<%|<\?/.test(code)) continue;
    const attrs = m[1];
    if (/(?:^|\s)(?:src|nomodule)(?=[\s=]|$)/i.test(attrs)) continue;
    const type = ((/(?:^|\s)type\s*=\s*["']?([^"'\s]*)/i.exec(attrs) || [])[1] || "").toLowerCase();
    const module = type === "module";
    if (!module && type && !/^(?:text|application)\/(?:x-)?(?:java|ecma)script$|^text\/jscript$/.test(type)) continue;
    // 模块里的 import/export 只有真当模块才编得过，vm 默认编不了模块，提到这两个词的就不查了
    if (module && /\b(?:import|export)\b/.test(code)) continue;
    scripts.push({ code, module, line: lineOf(m.index + "<script".length + attrs.length + 1) });
  }
  // 报错里带上出错那一行（太长就截光标前后一段），模型不用再去翻文件
  const snippet = (n, e) => {
    const text = ((lines = lines || html.split("\n"))[n - 1] || "").trim();
    if (text.length <= 80) return text;
    // V8 报错第二、三行是出错那行和底下的 ^，^ 的位置减掉那行的缩进就是在 text 里的位置
    const [, shown = "", caret = ""] = String(e.stack || "").split("\n");
    const col = caret.indexOf("^") - (shown.length - shown.trimStart().length);
    const from = Math.max(0, Math.min(col - 40, text.length - 80));
    return (from > 0 ? "…" : "") + text.slice(from, from + 80) + (from + 80 < text.length ? "…" : "");
  };
  const classic = [];
  for (const s of scripts) {
    // 模块照模块的规矩编：严格模式、可以顶层 await
    const code = s.module ? '(async function(){"use strict";' + s.code + "\n})" : s.code;
    try {
      new vm.Script(code, { filename: "inline-script", lineOffset: s.line - 1 });
      if (!s.module) classic.push(s);
    } catch (e) {
      if (!e || e.name !== "SyntaxError") continue;
      const n = +((/^inline-script:(\d+)/.exec(String(e.stack)) || [])[1]) || s.line;
      out.push(`脚本第 ${n} 行：${e.message}（${snippet(n, e)}）`);
    }
  }
  if (!classic.length) return out;
  const ctx = vm.createContext({});
  vm.runInContext(`for (const k of ${JSON.stringify(BROWSER_GLOBALS)}) Object.defineProperty(globalThis, k, { value: null })`, ctx);
  for (const s of classic) {
    // throw 0 垫在 "use strict" 后面：严格模式得保住，不然块里的函数声明会被当成全局变量，平白撞名
    const head = /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*(["'])use strict\1/.exec(s.code);
    const code = head ? head[0] + ";throw 0;" + s.code.slice(head[0].length) : "throw 0;" + s.code;
    try {
      new vm.Script(code, { filename: "inline-script", lineOffset: s.line - 1 }).runInContext(ctx);
    } catch (e) {
      const dup = e !== 0 && e && e.name === "SyntaxError" && /^Identifier '([^']+)' has already been declared$/.exec(e.message);
      if (!dup) continue;
      // V8 只报到这段开头，具体哪一行自己找
      const name = dup[1];
      const decl = new RegExp(`(?:let|const|var|class|function)(?:\\s*\\*\\s*|\\s+)${name.replace(/\$/g, "\\$")}(?![\\p{ID_Continue}$\\u200c\\u200d])`, "u").exec(s.code);
      const n = s.line + (decl ? (s.code.slice(0, decl.index).match(/\n/g) || []).length : 0);
      out.push(BROWSER_GLOBALS.includes(name)
        ? `脚本第 ${n} 行在最外层声明了 ${name}，这是浏览器自带的全局变量，得改个名`
        : `脚本第 ${n} 行又声明了一次 ${name}，前面一段 <script> 已经声明过（各段共用全局变量）`);
    }
  }
  return out;
}

module.exports = { inlineScriptErrors };
