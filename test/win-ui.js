// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 同一份界面在 Windows 上打开，不该冒出只有 mac 才有的东西。
 *
 *   node test/win-ui.js
 *
 * 七件事，每件都配反向对照（把修好的地方改回老样子，断言得红——不然删光了也全绿）：
 *   ① 「这台是什么系统」那几个小函数：Win32/Windows、MacIntel/macOS、Linux 各认成哪家
 *   ② 界面文字里不许再写死「访达」「⌘」「Cmd」——注释、按平台挑词的那两处除外
 *   ③ 用到这几个小函数的每一句，三家各拼一遍：Windows 那份说资源管理器 / Ctrl，英文界面也翻得出来
 *   ④ 「系统授权」那张卡：只有跑服务的是 mac 才摆；「去授权」没打开要说一声
 *   ⑤ 头像候选表里没有 Windows 10 画不出来的表情（Emoji 13.0 以后的）
 *   ⑥ 等宽字：Windows 上中文落到微软雅黑而不是新宋体；mac / Linux 落到的字跟改之前一样
 *   ⑦ 原生控件（下拉框、滚动条）跟着深浅主题走
 *
 * 只读源码，真函数切出来放进 vm 跑，平台靠喂假 navigator / 传 "win32" 切换。
 * 不开窗口、不起服务、不碰数据目录。真页面里画出来对不对（卡藏没藏、计算样式）在 frontend.js。
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

let pass = 0, fail = 0;
const ok = (cond, msg, extra) => {
  if (cond) { pass++; console.log("  ✓ " + msg); }
  else { fail++; console.log("  ✗ " + msg + (extra !== undefined ? "  ← " + JSON.stringify(extra) : "")); }
};

/** 按前后两个记号切一段真源码。切不到就当场炸：静悄悄切到空串，下面每条断言都会空跑成绿的 */
function cut(src, from, to, what) {
  const a = src.indexOf(from);
  const b = a < 0 ? -1 : src.indexOf(to, a + from.length);
  if (a < 0 || b < 0) throw new Error(what + " 切不到了（「" + from + "」或「" + to + "」改名、挪走了？）");
  return src.slice(a, b);
}

// 注释剥离借 icons.js 那一份（栈式：模板串里嵌代码、正则里的引号都认得），换成等长空格、行号不动。
// 不另抄一份：两份各自演化，哪天一边修了漏判，另一边还在漏
const STRIP = vm.runInNewContext(
  cut(read("test/icons.js"), "const KW = [", "/** 「这里的 emoji 是数据", "icons.js 的 stripComments")
  + "\n;({ stripComments, stripHtmlComments })", {});
const codeOf = (rel, raw) => rel.endsWith(".css") ? STRIP.stripHtmlComments(raw)
  : rel.endsWith(".html") ? STRIP.stripHtmlComments(STRIP.stripComments(raw))
  : STRIP.stripComments(raw);

const listDir = (dir, ext) => fs.readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith(ext)).sort().map((f) => dir + "/" + f);
// 前端自己写的全部：public/js 下的脚本、public 根上的页面和 svgfig.js
const PUBLIC_JS = listDir("public/js", ".js").concat(listDir("public", ".js"));
const PUBLIC_HTML = listDir("public", ".html");

// 三家各自的 navigator 长什么样。Linux 那份故意不给 userAgentData：
// 网页版从局域网 http 打开不算安全上下文，这个字段压根不存在，只能退回 navigator.platform
const NAVS = {
  win32: { platform: "Win32", userAgentData: { platform: "Windows" } },
  darwin: { platform: "MacIntel", userAgentData: { platform: "macOS" } },
  linux: { platform: "Linux x86_64" },
};
const PLATS = Object.keys(NAVS);

const APP00 = read("public/js/app-00-ui.js");
const APP02 = read("public/js/app-02.js");
const APP06 = read("public/js/app-06.js");
const OS_SRC = cut(APP00, "/* ---------- 这台机器是什么系统", "/* 自建 tooltip", "app-00-ui.js 的系统判断");
const SC_SRC = cut(APP02, "const SC_PLATFORM = (", "let toastTimer", "app-02.js 的快捷键显示");

/** 给一台假机器，把系统判断（和快捷键显示）跑起来。nav 为空 = 连 navigator 都没有 */
function boot(nav, osSrc = OS_SRC) {
  const ctx = vm.createContext(nav ? { navigator: nav } : {});
  vm.runInContext(osSrc + "\n;globalThis.__os = { uiOsOf, UI_OS, fileMgrName, modKeyName };", ctx);
  vm.runInContext(SC_SRC + "\n;globalThis.__sc = { SC_MAC, accelDisplay };", ctx);
  return ctx;
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n【0】注释剥离器本身");
{
  ok(!STRIP.stripComments("const a = 1; // 在访达里打开").includes("访达"), "行注释里的「访达」被剥掉（注释里说访达不算界面文字）");
  ok(!STRIP.stripComments("/* ⌘F 搜索\n   在访达里 */ const b = 2;").includes("访达"), "跨行块注释也剥干净");
  ok(STRIP.stripComments("const t = `在访达里打开`;").includes("访达"), "反向对照：模板串里的留着（那是真要显示的字）");
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n【1】这台是什么系统：三家各认成哪家、主修饰键和文件管理器各叫什么");
{
  const EXPECT = { win32: ["win", "资源管理器", "Ctrl"], darwin: ["mac", "访达", "⌘"], linux: ["linux", "文件管理器", "Ctrl"] };
  for (const p of PLATS) {
    const o = boot(NAVS[p]).__os;
    const [os, fm, mod] = EXPECT[p];
    ok(o.UI_OS === os && o.fileMgrName() === fm && o.modKeyName() === mod,
      `${NAVS[p].platform} 认成 ${os}：文件管理器叫「${fm}」，主修饰键写「${mod}」`, [o.UI_OS, o.fileMgrName(), o.modKeyName()]);
  }
  const bare = boot(null).__os;
  ok(bare.UI_OS === "linux" && bare.fileMgrName() === "文件管理器", "连 navigator 都没有时不炸，按最中性的那套说（文件管理器 / Ctrl）", bare.UI_OS);

  // 服务端报的是 node 的写法（darwin / win32），前端拿到的是浏览器的写法，两种都得认
  const NAMES = [["darwin", "mac"], ["win32", "win"], ["linux", "linux"], ["freebsd", "linux"], ["", "linux"],
    ["Windows", "win"], ["macOS", "mac"], ["MacIntel", "mac"], ["iPad", "mac"]];
  const wrongNames = (o) => NAMES.filter(([n, want]) => o.uiOsOf(n) !== want).map(([n]) => n);
  ok(wrongNames(bare).length === 0, "node 的写法（darwin / win32 / linux）和浏览器的写法（Windows / macOS / MacIntel）都认得对", wrongNames(bare));

  // 反向对照：「darwin」里也有「win」三个字母，先判 win 的话 mac 服务端会被当成 Windows
  const MAC_IF = 'if (/mac|darwin|iphone|ipad|ipod/i.test(p)) return "mac";';
  const WIN_IF = 'if (/win/i.test(p)) return "win";';
  const swapped = OS_SRC.replace(MAC_IF, "\u0000").replace(WIN_IF, MAC_IF).replace("\u0000", WIN_IF);
  ok(swapped !== OS_SRC && wrongNames(boot(null, swapped).__os).includes("darwin"),
    "反向对照：把两个判断换个先后，darwin 就被认成 Windows——上面那条抓得住");

  // 快捷键面板（app-02 的 SC_MAC）和这里各认一次平台，两边要是说法不一，画布上就会一个按钮写 ⌘Z、旁边一句写 Ctrl
  const disagree = PLATS.filter((p) => { const c = boot(NAVS[p]); return (c.__os.UI_OS === "mac") !== c.__sc.SC_MAC; });
  ok(disagree.length === 0, "跟快捷键面板认的平台三家都一致", disagree);
  const sc = Object.fromEntries(PLATS.map((p) => [p, boot(NAVS[p]).__sc]));
  ok(sc.win32.accelDisplay("Mod+Z") === "Ctrl+Z" && sc.win32.accelDisplay("Shift+Mod+Z") === "Ctrl+Shift+Z",
    "Windows 上撤销 / 重做写成 Ctrl+Z / Ctrl+Shift+Z", [sc.win32.accelDisplay("Mod+Z"), sc.win32.accelDisplay("Shift+Mod+Z")]);
  ok(sc.linux.accelDisplay("Mod+Z") === "Ctrl+Z", "Linux 同样是 Ctrl+Z", sc.linux.accelDisplay("Mod+Z"));
  ok(sc.darwin.accelDisplay("Mod+Z") === "⌘Z" && sc.darwin.accelDisplay("Shift+Mod+Z") === "⇧⌘Z",
    "反向对照：mac 上照旧是 ⌘Z / ⇧⌘Z", [sc.darwin.accelDisplay("Mod+Z"), sc.darwin.accelDisplay("Shift+Mod+Z")]);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n【2】界面文字里不许写死「访达」「⌘」「Cmd」");
// ⌥ ⌃ 也算：Windows 键盘上同样没有。Cmd 前后不许贴字母，免得把 upCmd、execCommand 这类变量名算进来
const MAC_WORD = /访达|Finder|[⌘⌥⌃]|(?<![A-Za-z])Cmd(?![a-z])/;
// 允许留着的只有「按平台挑词」那两处本身。整行比对，不按行号：行号一改上面的代码就漂
const ALLOW = [
  ["public/js/app-00-ui.js", 'return os === "mac" ? "访达" : os === "win" ? "资源管理器" : "文件管理器";'],
  ["public/js/app-00-ui.js", 'return os === "mac" ? "⌘" : "Ctrl";'],
  ["public/js/app-02.js", 'const MOD = { Meta: "⌘", Ctrl: "⌃", Alt: "⌥", Shift: "⇧" };'],
];
function macWordHits(rel, code) {
  const out = [];
  code.split("\n").forEach((line, i) => {
    if (!MAC_WORD.test(line)) return;
    if (ALLOW.some(([f, l]) => f === rel && line.trim() === l)) return;
    out.push(rel + ":" + (i + 1) + "  " + line.trim().slice(0, 90));
  });
  return out;
}
// i18n.js 不扫：它是词典，键就是中文原句，mac 那份「在访达里打开」本来就该有一条
const SCAN = PUBLIC_JS.filter((f) => f !== "public/js/i18n.js").concat(PUBLIC_HTML);
const CODE = Object.fromEntries(SCAN.map((rel) => [rel, codeOf(rel, read(rel))]));
{
  ok(SCAN.length >= 20 && SCAN.includes("public/js/app-07-canvas.js") && SCAN.includes("public/index.html"),
    `扫了 ${SCAN.length} 个前端文件（画布那几个、两张页面都在里头）`);
  const hits = SCAN.flatMap((rel) => macWordHits(rel, CODE[rel]));
  ok(hits.length === 0, "注释以外没有一处写死 mac 的叫法", hits);
  const stale = ALLOW.filter(([f, l]) => !CODE[f].split("\n").some((x) => x.trim() === l));
  ok(stale.length === 0, "放行的那几行都还在（不在了说明挑词的地方挪了，放行表得跟着改）", stale);

  // 反向对照：老写法摆回去，得一条条抓出来；写在注释里的不算
  const BAIT = [
    ["const a = `<button title=\"在访达里打开\">`;", true],
    ["canvasToast(`框选中 ${n} 个节点。Shift/⌘ 点节点可加选减选`);", true],
    ["el.title = \"撤销（Ctrl/Cmd+Z）\";", true],
    ["toast('已复制文件，去微信 / 邮件 / Finder 里直接粘');", true],
    ["// 在访达里打开\nconst upCmd = 1; /* ⌘F */ document.execCommand(\"copy\");", false],
  ];
  const missed = BAIT.filter(([s, want]) => (macWordHits("bait.js", STRIP.stripComments(s)).length > 0) !== want).map(([s]) => s);
  ok(missed.length === 0, "反向对照：四句老写法都抓到，注释和变量名里的不误报", missed);
  const canvas = "public/js/app-07-canvas.js";
  const oldCanvas = CODE[canvas].split("${modKeyName()}").join("⌘").split('${accelDisplay("Mod+Z")}').join("Ctrl/Cmd+Z");
  ok(oldCanvas !== CODE[canvas] && macWordHits(canvas, oldCanvas).length >= 2,
    "反向对照：把画布工具栏改回「Shift/⌘」「Ctrl/Cmd+Z」，扫得出来");
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n【3】用到这几个小函数的每一句：三家各拼一遍，再翻成英文");
const { tr } = require("../public/js/i18n.js");
const HAN = /[一-鿿]/;
{
  // 找出 ${fileMgrName()} / ${modKeyName()} / ${accelDisplay("…")} 所在的那一句：往两边扩到引号、尖括号或别的 ${} 为止
  const CALL = /\$\{(?:fileMgrName\(\)|modKeyName\(\)|accelDisplay\("[^"`]*"\))\}/g;
  const STOP = new Set(['"', "'", "`", "<", ">", "{", "}", "\n"]);
  const phrases = [];
  for (const rel of SCAN) {
    const code = CODE[rel];
    for (const m of code.matchAll(CALL)) {
      let a = m.index, b = m.index + m[0].length;
      while (a > 0 && !STOP.has(code[a - 1])) a--;
      while (b < code.length && !STOP.has(code[b])) b++;
      phrases.push({ rel, text: code.slice(a, b) });
    }
  }
  const has = (t) => phrases.some((p) => p.text === t);
  ok(phrases.length >= 10 && has("在${fileMgrName()}里打开") && has("撤销（${accelDisplay(\"Mod+Z\")}）")
    && has("可让助理再做一份，或去${fileMgrName()}里找找。") && phrases.some((p) => p.rel.endsWith("canvas-viewport.js")),
    `找到 ${phrases.length} 句（文件行的按钮、产物卡、复制提示、画布工具栏和框选提示都在）`, phrases.map((p) => p.text));

  const ctx = Object.fromEntries(PLATS.map((p) => [p, boot(NAVS[p])]));
  // 句子当模板串在那台假机器上求值，拿到的就是那台上真显示的字
  const render = (p, text) => vm.runInContext("`" + text + "`", ctx[p]);
  const bad = { win32: [], linux: [], darwin: [], en: [] };
  for (const { text } of phrases) {
    const isFm = text.includes("fileMgrName");
    const out = Object.fromEntries(PLATS.map((p) => [p, render(p, text)]));
    if (MAC_WORD.test(out.win32) || !(isFm ? out.win32.includes("资源管理器") : out.win32.includes("Ctrl"))) bad.win32.push(out.win32);
    if (MAC_WORD.test(out.linux) || !(isFm ? out.linux.includes("文件管理器") : out.linux.includes("Ctrl"))) bad.linux.push(out.linux);
    if (!MAC_WORD.test(out.darwin)) bad.darwin.push(out.darwin);
    // 画布那几句一向没进词典（整块画布界面都还没英文），这里只管文件管理器那几句
    if (isFm) for (const p of PLATS) {
      const en = tr(out[p], "en");
      if (HAN.test(en) || (p !== "darwin" && /Finder/.test(en))) bad.en.push(p + "：" + out[p] + " → " + en);
    }
  }
  ok(bad.win32.length === 0, "Windows 上每句都说资源管理器 / Ctrl，没有一句带访达、⌘", bad.win32);
  ok(bad.linux.length === 0, "Linux 上每句都说文件管理器 / Ctrl", bad.linux);
  ok(bad.darwin.length === 0, "反向对照：同样这些句子在 mac 上还是访达 / ⌘（说明真是按平台换的，不是一律写成 Ctrl）", bad.darwin);
  ok(bad.en.length === 0, "英文界面三家都翻得出来，Windows / Linux 那份也不会冒出 Finder", bad.en);
  ok(HAN.test(tr("在资源管理器里乱打开一通", "en")), "反向对照：词典里没有的句子原样留着中文——上面那条真能抓到漏翻的");
  ok(/Finder/.test(tr("在访达里打开", "en")) && /File Explorer/.test(tr("在资源管理器里打开", "en")),
    "mac 那份英文仍是 Finder，Windows 那份是 File Explorer", [tr("在访达里打开", "en"), tr("在资源管理器里打开", "en")]);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n【4】「系统授权」那张卡：只有跑服务的是 mac 才摆");
{
  const CARD_SRC = cut(APP06, "/** 「系统授权」那张卡给不给看", "function renderSecurityPane", "app-06.js 的 sysPermsCardShown");
  const loadCard = (nav, src = CARD_SRC) => {
    const c = boot(nav);
    vm.runInContext(src + "\n;globalThis.__card = sysPermsCardShown;", c);
    return c.__card;
  };
  // [眼前这台, 服务端报的 process.platform（undefined = 还没拿到）, 该不该摆]
  const CASES = [
    ["win32", "win32", false], ["win32", undefined, false],
    ["linux", "linux", false], ["linux", undefined, false],
    ["darwin", "darwin", true], ["darwin", undefined, true],
    ["darwin", "win32", false],   // 网页版：在 mac 上打开一台 Windows 服务器，权限授给的是那台
    ["win32", "darwin", true],    // 反过来：在 Windows 上打开 mac 服务器，那台确实要授权
  ];
  const wrong = (src) => CASES.filter(([c, h, want]) => loadCard(NAVS[c], src)(h) !== want).map((x) => x.join(" / "));
  ok(wrong(CARD_SRC).length === 0, "Windows / Linux 上不摆，mac 上照摆；服务端报回来以后以跑服务的那台为准", wrong(CARD_SRC));
  const always = CARD_SRC.replace('return hostPlatform ? hostPlatform === "darwin" : os === "mac";', "return true;");
  ok(always !== CARD_SRC && wrong(always).some((x) => x.startsWith("win32 / win32")), "反向对照：改回「谁都摆」，Windows 那条立刻红");
  const clientOnly = CARD_SRC.replace('return hostPlatform ? hostPlatform === "darwin" : os === "mac";', 'return os === "mac";');
  ok(clientOnly !== CARD_SRC && wrong(clientOnly).length === 2, "反向对照：只看眼前这台，跨系统打开的那两条红");

  const SEC = codeOf("public/js/app-06.js", cut(APP06, "function renderSecurityPane", "// ================= 快捷键面板", "renderSecurityPane"));
  ok(/id="sec-sys-card"\$\{sysPermsCardShown\(\) \? "" : ' style="display:none"'\}/.test(SEC),
    "卡片一画出来就按眼前这台先藏（不等接口回来，免得 Windows 上闪一下）");
  ok(/const shown = sysPermsCardShown\(d\.platform\);\s*if \(card\) card\.style\.display = shown \? "" : "none";\s*if \(!shown\) return;/.test(SEC),
    "接口回来按服务端报的那台再定一次，不摆就不往下画");
  ok(/\$\{sysPermsCardShown\(\) \? "系统授权、" : ""\}审计日志/.test(SEC), "成员看到的那句说明也跟着：没这张卡就不提「系统授权」");
  // 「去授权」：服务端开不出那一页会回 ok:false，以前不看回话，点下去什么都不发生
  const MSG = "系统设置这一页没打开，可到「隐私与安全性」里自己找";
  ok(/\.then\(x => x\.json\(\)\)\.catch\(\(\) => null\);\s*if \(!r \|\| !r\.ok\) toast\("/.test(SEC) && SEC.includes(MSG),
    "「去授权」没打开（回 ok:false 或请求失败）会弹一句提示");
  ok([...MSG].length <= 40 && !MSG.includes("他") && !HAN.test(tr(MSG, "en")), "那句提示不超过 40 字、英文界面有译文", tr(MSG, "en"));
  const silent = SEC.replace(/if \(!r \|\| !r\.ok\) toast\([^;]*;/, "");
  ok(silent !== SEC && !(/if \(!r \|\| !r\.ok\) toast\("/.test(silent)), "反向对照：去掉那句提示，上面那条抓得住");
  // 前端靠服务端报 platform 才分得清「跑服务的是哪台」；那个字段没了，就只能按眼前这台猜
  const SERVER = codeOf("server.js", read("server.js"));
  ok(/app\.get\("\/api\/security\/system",[\s\S]{0,200}?platform: process\.platform/.test(SERVER),
    "服务端 /api/security/system 回话里带着 platform（跑服务那台的系统）");
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n【5】头像候选表：Windows 10 画不出来的表情一个都不许有");
// Windows 10 自带的 Segoe UI Emoji 停在 Emoji 12.x；13.0 以后加的在那边是一个方框。
// 1FA70–1FAFF 这一片大部分是 13.0 以后的，只有下面四小段是 12.0 就有的（芭蕾舞鞋那几样、
// 血滴创可贴听诊器、溜溜球风筝降落伞、土星椅子剃刀斧头油灯班卓琴）；片外还有零散几个。
const E12_IN_FA = [[0x1FA70, 0x1FA73], [0x1FA78, 0x1FA7A], [0x1FA80, 0x1FA82], [0x1FA90, 0x1FA95]];
const NEW_LOOSE = [[0x26A7, 0x26A7], [0x1F6D6, 0x1F6DF], [0x1F6FB, 0x1F6FF], [0x1F7F0, 0x1F7FF], [0x1F90C, 0x1F90C],
  [0x1F972, 0x1F972], [0x1F977, 0x1F979], [0x1F9A3, 0x1F9A4], [0x1F9AB, 0x1F9AD], [0x1F9CB, 0x1F9CC]];
const inR = (cp, rs) => rs.some(([a, b]) => cp >= a && cp <= b);
function tooNew(s) {
  const why = [];
  if (s.includes("‍")) why.push("几个表情用 ZWJ 拼起来的（Windows 上会拆成几个）");
  for (const ch of s) {
    const cp = ch.codePointAt(0), hex = "U+" + cp.toString(16).toUpperCase();
    if (cp >= 0x1F1E6 && cp <= 0x1F1FF) why.push(hex + " 国旗（Windows 上只画两个字母）");
    else if (cp >= 0x1FA70 && cp <= 0x1FAFF && !inR(cp, E12_IN_FA)) why.push(hex + " 是 13.0 以后的");
    else if (inR(cp, NEW_LOOSE)) why.push(hex + " 是 13.0 以后的");
  }
  return why;
}
{
  const reg = APP00.indexOf("/* emoji-数据区 起：");
  const arr = APP00.indexOf("const AVATAR_EMOJI = [");
  const end = APP00.indexOf("/* emoji-数据区 止 */");
  ok(reg >= 0 && reg < arr && arr < end, "表还在 icons.js 认的那对「emoji 数据区」记号中间");
  const EMOJI = vm.runInNewContext(cut(APP00, "const AVATAR_EMOJI = [", "/* emoji-数据区 止 */", "AVATAR_EMOJI") + "\n;AVATAR_EMOJI", {});
  ok(Array.isArray(EMOJI) && EMOJI.length === 64 && new Set(EMOJI).size === 64, "候选还是 64 个、没有重复（换掉的两个补上了，八行八列排得满）", EMOJI.length);
  const bad = EMOJI.map((e) => [e, tooNew(e)]).filter(([, w]) => w.length);
  ok(bad.length === 0, "没有一个是 Emoji 13.0 以后的、拼起来的或国旗", bad);
  ok(!EMOJI.includes("🧋") && !EMOJI.includes("🪄"), "珍珠奶茶、魔法棒（都是 13.0）不在表里了");
  const NEWER = ["🧋", "🪄", "🥲", "🫠", "🪨", "🛖", "🐻‍❄️", "🇨🇳"];
  const OLDER = ["🦾", "🪀", "🥱", "🍵", "✨", "🦩", "🪑"];
  ok(NEWER.every((e) => tooNew(e).length > 0), "反向对照：奶茶、魔法棒、含泪笑、融化脸、石头、小屋、北极熊、国旗都判得出来",
    NEWER.filter((e) => !tooNew(e).length));
  ok(OLDER.every((e) => tooNew(e).length === 0), "反向对照：12.0 就有的（机械臂、溜溜球、哈欠、茶、火烈鸟、椅子）不误伤",
    OLDER.filter((e) => tooNew(e).length));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n【6】等宽字：Windows 上中文落到微软雅黑；mac / Linux 落到的字跟改之前一样");
const UI_CSS = read("public/css/ui.css");
const UI_CSS_CODE = codeOf("public/css/ui.css", UI_CSS);
const stack = (s) => s.split(",").map((x) => x.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
const defsOf = (name) => [...UI_CSS_CODE.matchAll(new RegExp("^\\s*" + name + ":\\s*([^;]+);", "gm"))].map((m) => m[1].trim());
const MONO_DEF = defsOf("--font-mono"), SYS_DEF = defsOf("--font-mono-sys");
const MONO = stack(MONO_DEF[0] || ""), SYS = stack(SYS_DEF[0] || "");
const LATIN_MONO = ["ui-monospace", "SFMono-Regular", "SF Mono", "Menlo", "Consolas"];
const CJK = ["PingFang SC", "Microsoft YaHei UI", "Microsoft YaHei"];
{
  ok(MONO_DEF.length === 1 && SYS_DEF.length === 1, "两份等宽字各只定义一处（深色主题里没有另一份把它盖掉）", [MONO_DEF.length, SYS_DEF.length]);
  const lastLatin = Math.max(...LATIN_MONO.map((f) => MONO.indexOf(f)));
  ok(CJK.every((f) => MONO.indexOf(f) > lastLatin) && MONO[MONO.length - 1] === "monospace",
    "--font-mono：苹方、微软雅黑排在西文等宽字后面、monospace 前面（排前面英文就不等宽了）", MONO);
  ok(SYS[0] === "Consolas" && SYS.includes("Microsoft YaHei UI") && SYS.includes("Microsoft YaHei") && SYS[SYS.length - 1] === "monospace"
    && !SYS.some((f) => ["ui-monospace", "SFMono-Regular", "SF Mono", "Menlo", "PingFang SC"].includes(f)),
    "--font-mono-sys：只在 Consolas 后面补微软雅黑，一款 mac / Linux 上有的字都不点名", SYS);

  // 别处不许再各写一串等宽字：一写就又是一份没有中文回退的
  const MONO_NAME = /\b(?:monospace|ui-monospace|Menlo|Consolas|SFMono-Regular|SF Mono|Monaco|Courier(?: New)?|Cascadia (?:Code|Mono)|JetBrains Mono|Fira Code|Source Code Pro|DejaVu Sans Mono)\b/;
  const isDef = (rel, line) => rel === "public/css/ui.css" && /^\s*--font-mono(?:-sys)?:/.test(line);
  const monoHits = (rel, code) => code.split("\n").map((l, i) => [l, i]).filter(([l]) => MONO_NAME.test(l) && !isDef(rel, l))
    .map(([l, i]) => rel + ":" + (i + 1) + "  " + l.trim().slice(0, 90));
  const ALL = { ...CODE, "public/js/i18n.js": codeOf("public/js/i18n.js", read("public/js/i18n.js")), "public/css/ui.css": UI_CSS_CODE };
  const hits = Object.entries(ALL).flatMap(([rel, code]) => monoHits(rel, code));
  ok(hits.length === 0, "CSS、页面、脚本里没有别处再写死一串等宽字，一律 var(--font-mono) / var(--font-mono-sys)", hits);
  const bait = UI_CSS_CODE + "\n.x { font-family: ui-monospace, Menlo, monospace; }";
  const baitJs = "el.innerHTML = `<textarea style=\"font-family:Consolas,monospace\">`;";
  ok(monoHits("public/css/ui.css", bait).length === 1 && monoHits("bait.js", baitJs).length === 1,
    "反向对照：CSS 里、脚本拼的行内样式里各塞一串老写法，都抓得到");

  // 字落到哪款，按三家各装了什么推一遍。latin = 只管西文；han = 汉字西文都管。
  // 「monospace」这个泛称：Windows 上 Chromium 给简体汉字的默认等宽字是新宋体（细、发虚、比旁边小一号）；
  // mac 默认那款没有汉字，按页面 lang=zh-CN 回退到苹方；Linux 上点名的那几款一款都没有
  const ENV = {
    win32: { has: { "Consolas": "latin", "Courier New": "latin", "Microsoft YaHei UI": "han", "Microsoft YaHei": "han", "NSimSun": "han" },
      generic: { latin: "Consolas", han: "NSimSun" } },
    darwin: { has: { "ui-monospace": "latin", "Menlo": "latin", "Monaco": "latin", "Courier": "latin", "PingFang SC": "han" },
      alias: { "ui-monospace": "SF Mono" }, generic: { latin: "Courier", han: "PingFang SC" } },
    linux: { has: {}, generic: { latin: "DejaVu Sans Mono", han: "Noto Sans CJK SC" } },
  };
  const resolve = (fonts, plat, script) => {
    const env = ENV[plat];
    for (const f of fonts) {
      if (f === "monospace") return env.generic[script];
      const cov = env.has[f];
      if (cov && (script === "latin" || cov === "han")) return (env.alias && env.alias[f]) || f;
    }
    return env.generic[script];
  };
  const pick = (fonts, plat) => resolve(fonts, plat, "latin") + " / " + resolve(fonts, plat, "han");
  // 改之前各处写的是哪串、现在换成了哪份。浏览器默认（pre 没写字体）记作单个 monospace
  const OLD = [
    ["ui-monospace, SFMono-Regular, \"SF Mono\", Menlo, Consolas, monospace", MONO, "原来的 --font-mono（.tp-* / 画布 / 代码里一大片）"],
    ["ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", MONO, "审批条的 diff、配对码、提问卡的命令"],
    ["ui-monospace, SFMono-Regular, Menlo, monospace", MONO, "引擎页、两步验证的密钥"],
    ["ui-monospace, Menlo, monospace", MONO, "两步验证那几个输入框"],
    ["ui-monospace, monospace", MONO, "画布报错、技能扫描"],
    ["Consolas, ui-monospace, monospace", MONO, "代码块标题栏"],
    ["Consolas, monospace", SYS, "审批条的命令、安全页的名单框"],
    ["monospace", SYS, "工具输出、模板预览、资料库纯文本（原来没写，吃浏览器默认）"],
  ];
  for (const plat of ["darwin", "linux"]) {
    const changed = OLD.filter(([o, n]) => pick(stack(o), plat) !== pick(n, plat)).map(([o, n, w]) => w + "：" + pick(stack(o), plat) + " → " + pick(n, plat));
    ok(changed.length === 0, `${plat === "darwin" ? "mac" : "Linux"} 上八处落到的字（西文 / 汉字）跟改之前一模一样`, changed);
  }
  const win = OLD.map(([o, n, w]) => [w, pick(stack(o), "win32"), pick(n, "win32")]);
  ok(win.every(([, , now]) => now === "Consolas / Microsoft YaHei UI"), "Windows 上八处都是西文 Consolas、汉字微软雅黑", win.map((x) => x[0] + "：" + x[2]));
  ok(win.every(([, before]) => before === "Consolas / NSimSun"), "反向对照：改之前 Windows 上这八处的汉字全落到新宋体（这就是要修的那个）",
    win.map((x) => x[0] + "：" + x[1]));
  ok(pick(MONO, "darwin") !== pick(stack("monospace"), "darwin"),
    "反向对照：要是把浏览器默认那几处也换成 --font-mono，mac 上西文会从默认那款变成 SF Mono——所以才单留 --font-mono-sys");
  ok(pick(["PingFang SC", "ui-monospace", "monospace"], "darwin") !== pick(MONO, "darwin"),
    "反向对照：中文字体排到西文等宽字前面，mac 上英文就跟着变——上面「一模一样」那条抓得住这种排法");
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n【7】原生控件跟着深浅主题走（color-scheme）");
{
  const INDEX_CODE = CODE["public/index.html"];
  // 按层叠挑一个值：选择器能对上的里头，特异性高的赢，一样高的后写的赢。只认这几种写法，够用
  const SPEC = { "html": 1, ":root": 10, 'html[data-theme="dark"]': 11, 'html[data-theme="light"]': 11, ":root[data-theme=\"dark\"]": 20, ":root[data-theme=\"light\"]": 20 };
  const matches = (sel, theme) => sel === "html" || sel === ":root" || sel.endsWith('[data-theme="' + theme + '"]');
  // 「选择器 { 声明 }」一段段拆出来。不用 /([^{}]+)\{([^{}]*)\}/g：index.html 里大段脚本没有花括号对得上的地方，
  // 那条正则每个起点都回溯一遍，单这一节就跑五十秒
  function* rules(css) {
    let from = 0;
    for (let i = 0; i < css.length; i++) {
      if (css[i] === "}") { from = i + 1; continue; }
      if (css[i] !== "{") continue;
      const end = css.indexOf("}", i);
      if (end < 0) return;
      const inner = css.indexOf("{", i + 1);
      if (inner >= 0 && inner < end) { from = i + 1; continue; } // @media 这种外层：里面那条才是
      yield [null, css.slice(from, i), css.slice(i + 1, end)];
      i = end;
      from = end + 1;
    }
  }
  function scheme(css, theme) {
    let best = null;
    for (const m of rules(css)) {
      const d = /(?:^|;)\s*color-scheme\s*:\s*([^;]+)/.exec(m[2]);
      if (!d) continue;
      for (const sel of m[1].split(",").map((s) => s.trim())) {
        if (!(sel in SPEC)) throw new Error("color-scheme 写在了没见过的选择器上：" + sel + "（这个小模型不认，得补）");
        if (matches(sel, theme) && (!best || SPEC[sel] >= best.spec)) best = { spec: SPEC[sel], v: d[1].trim() };
      }
    }
    return best ? best.v : "normal";
  }
  const all = UI_CSS_CODE + "\n" + INDEX_CODE;
  ok(scheme(all, "dark") === "dark", "深色主题：原生控件画成深色（下拉框弹出来不再是一整块白底）", scheme(all, "dark"));
  ok(scheme(all, "light") === "light", "浅色主题：写明 light（跟不写一个样子）", scheme(all, "light"));
  const removed = all.replace(/html\s*\{\s*color-scheme:[^}]*\}/, "").replace(/html\[data-theme="dark"\]\s*\{\s*color-scheme:[^}]*\}/, "");
  ok(removed !== all && scheme(removed, "dark") === "normal", "反向对照：删掉那两条，深色主题下又回到 normal（白底下拉框）");
}

console.log("\n" + (fail === 0 ? "全部通过" : "有失败") + "：" + pass + " 过 / " + fail + " 挂");
process.exit(fail === 0 ? 0 : 1);
