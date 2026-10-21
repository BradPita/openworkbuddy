// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 OpenWorkBuddy Contributors
"use strict";
// UI 色彩检查可独立提前运行，端到端测试复用同一实现和反向对照。
const fs = require("fs"), path = require("path"), assert = require("assert");
function testCssTokenGate(repoRoot = path.resolve(__dirname, "..", "..")) {
  const pub = path.join(repoRoot, "public");
  const files = [
    path.join(pub, "index.html"),
    path.join(pub, "css", "ui.css"),
    ...fs.readdirSync(path.join(pub, "js")).filter((f) => f.endsWith(".js")).map((f) => path.join(pub, "js", f)),
  ];
  const defined = new Set();
  for (const f of [files[0], files[1]]) {
    const t = fs.readFileSync(f, "utf8");
    for (const m of t.matchAll(/(--[a-zA-Z0-9_-]+)\s*:/g)) defined.add(m[1]);
  }
  const missing = new Map();
  const fillAsText = [];
  // 填充色当文字色用，代码里有三种写法，只堵一种是堵不住的——头两版闸门就只认第 ① 种，
  // 结果 ②③ 在评测页和自进化页躺了一路（绿勾绿字在白底上 3.30，暗底上 4.18，两头都不够 AA）：
  //   ① 写死：color: var(--owb-err)
  //   ② 插值：color:${ok ? "var(--owb-ok)" : "var(--owb-err)"}
  //   ③ 先存变量再用：const color = "var(--owb-err)" … style="color:${color}"
  // ①② 看 color: 后面那一段值；③ 看「光秃秃一个 var(--owb-x) 字符串」——这种字符串除了当颜色值传没别的用处，
  // 同一行提到 background/border/fill/stroke/shadow/outline 才放行（那是真把它当填充色用，正是它该待的地方）。
  const FILL = /var\(\s*--owb-(brand|err|ok)\s*[,)]/;
  const FG_VALUE = /(?<![-a-zA-Z])color:\s*(\$\{[^}]*\}|[^;"'`\n]*)/g;
  const LOOSE_STR = /["'`]var\(\s*--owb-(brand|err|ok)\s*\)["'`]/g;
  const REALLY_FILL = /background|border|fill|stroke|shadow|outline/;
  const lineOf = (t, i) => t.slice(0, i).split("\n").length;
  const scanFillAsText = (t, name, out) => {
    for (const m of t.matchAll(FG_VALUE)) if (FILL.test(m[1])) out.push(name + ":" + lineOf(t, m.index) + " 的 color");
    for (const m of t.matchAll(LOOSE_STR)) {
      const line = t.slice(t.lastIndexOf("\n", m.index) + 1, (t.indexOf("\n", m.index) + 1 || t.length + 1) - 1);
      if (!REALLY_FILL.test(line)) out.push(name + ":" + lineOf(t, m.index) + " 的 --owb-" + m[1] + "（存进变量再当颜色用）");
    }
  };
  for (const f of files) {
    const t = fs.readFileSync(f, "utf8");
    // var(--x) 带回退值的不算漏（var(--x, 兜底) 本来就允许没定义）
    for (const m of t.matchAll(/var\(\s*(--[a-zA-Z0-9_-]+)\s*\)/g)) {
      if (!defined.has(m[1])) missing.set(m[1], (missing.get(m[1]) || []).concat(path.basename(f)));
    }
    scanFillAsText(t, path.basename(f), fillAsText);
  }
  assert(missing.size === 0, "引用了没定义的 CSS 变量：" + [...missing].map(([k, v]) => k + "(" + [...new Set(v)].join(",") + ")").join("、"));
  assert(fillAsText.length === 0, "填充色令牌被当文字色用了，应换成 --owb-*-text：" + fillAsText.join("、"));
  // 反向断言：三种写法各造一份坏样本喂进去，一种抓不到就说明闸门这一路是摆设
  const bad1 = []; scanFillAsText(".x .i { color: var(--owb-err, #dc2626); }", "假1", bad1);
  const bad2 = []; scanFillAsText("`<b style=\"color:${ok ? \"var(--owb-ok)\" : \"var(--owb-text)\"}\">`", "假2", bad2);
  const bad3 = []; scanFillAsText('const tone = "var(--owb-brand)";', "假3", bad3);
  assert(bad1.length && bad2.length && bad3.length, `闸门漏了：写死=${bad1.length} 插值=${bad2.length} 变量=${bad3.length}`);
  // 正向对照：真拿它当填充色的三种写法一个都不许误报，不然逼着人把背景色也换成文字档
  const good = [];
  scanFillAsText('.chip { background: var(--owb-err); border-left-color: var(--owb-brand); }', "真1", good);
  scanFillAsText('btn.style.background = "var(--owb-err)";', "真2", good);
  scanFillAsText('`<i style="background:var(--owb-err);color:#fff">`', "真3", good);
  assert(good.length === 0, "闸门误伤了正经的填充用法：" + good.join("、"));
  assert(!defined.has("--owb-根本没有这个"), "闸门定义集失效");

  // 同一个毛病还有第 ④ 种写法，上面三种一个都盯不到：**直接写死十六进制**。
  // 令牌那一路堵死之后，自动化页和引擎卡片里躺着 6 条 `color: #16a34a` / `color: #dc2626`——
  // 绿字压白卡片只有 3.30:1（令牌层为此专门留了 --owb-ok-text，5.79:1），
  // 红字压深色卡片只有 3.41:1；而且写死的颜色压根不跟着主题翻，深色下要么糊要么刺眼。
  // 中性灰放行（分隔线、占位字本来就该用灰），只抓有颜色的。
  const hexSat = (h) => {
    let x = h.replace("#", "").toLowerCase();
    if (x.length === 3) x = [...x].map((c) => c + c).join("");
    const r = parseInt(x.slice(0, 2), 16), g = parseInt(x.slice(2, 4), 16), b = parseInt(x.slice(4, 6), 16);
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    return mx === 0 ? 0 : (mx - mn) / mx;
  };
  // 两头都是深色的面：浅色主题下它也还是深的，套 --owb-*-text（浅色档是深红/深绿）反而看不见。
  // 只放这一条具体选择器，不放整类——新加的写死颜色照样会被抓。
  const DARK_SURFACE = /#owb-toast/;
  // 免死判定要看「这条声明属于哪条规则」，不能只看它自己那一行：一条规则常常折成好几行写，
  // 选择器在第一行、background 在第二行，按行取就永远读不到选择器（pet.html 的 #drop 就是这样）。
  // 往前找到上一个 } 为止，中间那段一定含选择器。
  const ruleHeadAt = (t, i) => t.slice(t.lastIndexOf("}", i) + 1, i);
  const scanHexAsText = (t, name, out) => {
    for (const m of t.matchAll(/(?<![-a-zA-Z])color:\s*(#[0-9a-fA-F]{3,8})\b/g)) {
      if (hexSat(m[1]) <= 0.18) continue;
      if (DARK_SURFACE.test(ruleHeadAt(t, m.index))) continue;
      out.push(name + ":" + lineOf(t, m.index) + " 的 " + m[1]);
    }
  };
  const hexAsText = [];
  for (const f of [path.join(pub, "index.html"), path.join(pub, "css", "ui.css"), path.join(pub, "admin.html"), path.join(pub, "pet.html")]) {
    const t = fs.readFileSync(f, "utf8");
    for (const b of t.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) scanHexAsText(b[1], path.basename(f), hexAsText);
    if (f.endsWith(".css")) scanHexAsText(t, path.basename(f), hexAsText);
  }
  assert(hexAsText.length === 0,
    "文字颜色写死成十六进制了，不跟主题翻色、也绕开了 *-text 那一档（绿的在白底只有 3.30:1）：" + hexAsText.join("、"));
  // 反向对照：写死的抓得到；灰的和令牌的一个都不许误报；免死的那条只免它自己
  const h1 = []; scanHexAsText(".x .st.ok { color: #16a34a; }", "假", h1);
  const h2 = []; scanHexAsText(".x .meta { color: #6a6f7d; }\n.y { color: var(--owb-ok-text); }\n.z { background: #16a34a; }", "真", h2);
  const h3 = []; scanHexAsText("#owb-toast.err .i { color: #ff8f8f; }", "免", h3);
  const h4 = []; scanHexAsText(".other .i { color: #ff8f8f; }", "非免", h4);
  assert(h1.length === 1, "写死的十六进制文字色抓不到，这道闸是摆设");
  assert(h2.length === 0, "误伤了灰字/令牌/背景色：" + h2.join("、"));
  assert(h3.length === 0 && h4.length === 1, `免死名单跑偏了：免=${h3.length} 非免=${h4.length}`);
  // 第 ⑤ 种：写死的十六进制当**底色 / 边框**用。上面那道只管 color:，管不到这一路，
  // 三处真事故都是从这个口子溜过去的，而且一个比一个离谱：
  //   · 审批条：底 #fff7ed + 边 #fdba74，深色再单开一条 .ap-row 各写一遍。
  //     那根边压在页面底上只有 1.56:1，「任务停在这儿等你点头」这条提示等于没画边。
  //   · 场景 tab 选中的胶囊：写死 #17181c，可深色主题的轨道底正好也是 #17181c——
  //     1.00:1，胶囊整个消失，看不出选中的是哪一个。
  //   · 过程卡：写死 #fbfcfe，深色下是一整块白板（压页面底 17.43:1），
  //     上面的字是深色主题那档浅灰，白底浅灰 2.29:1，读不了。
  // 注意这三个的饱和度分别是 18 / 5 / 3——按「够不够花」筛一个都抓不到，
  // 所以这一路不看饱和度：底色和边框里只准出现 #fff / #000（蒙层、视频留黑那种跟主题无关的），
  // 其余一律要走令牌。var() 里的兜底值放行（var(--owb-warn, #d97706) 是本项目既有写法，主题照样翻）。
  const stripVar = (s) => { let o = s, n; do { n = o; o = o.replace(/var\([^()]*\)/g, " "); } while (o !== n); return o; };
  // 故意长期是深色 / 本来就是插画固有色的几处：单列具体选择器，不放整类
  const FIXED_SURFACE = /\.code-head|\.code-wrap|#drop/;
  const SURFACE_PROP = /(?<![-a-zA-Z])(background|background-color|border|border-color|border-top|border-right|border-bottom|border-left|border-top-color|border-right-color|border-bottom-color|border-left-color|outline|outline-color|box-shadow)\s*:\s*([^;{}]*)/g;
  const scanHexAsFill = (t, name, out) => {
    for (const m of t.matchAll(SURFACE_PROP)) {
      if (FIXED_SURFACE.test(ruleHeadAt(t, m.index))) continue;
      for (const h of stripVar(m[2]).match(/#[0-9a-fA-F]{3,8}\b/g) || []) {
        if (/^#(fff|ffffff|000|000000)$/i.test(h)) continue;
        out.push(name + ":" + lineOf(t, m.index) + " 的 " + h);
      }
    }
  };
  const hexAsFill = [];
  for (const f of [path.join(pub, "index.html"), path.join(pub, "css", "ui.css"), path.join(pub, "admin.html"), path.join(pub, "pet.html")]) {
    const t = fs.readFileSync(f, "utf8");
    for (const b of t.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) scanHexAsFill(b[1], path.basename(f), hexAsFill);
    if (f.endsWith(".css")) scanHexAsFill(t, path.basename(f), hexAsFill);
  }
  assert(hexAsFill.length === 0,
    "底色/边框写死成十六进制了，不跟主题翻色，深浅两套还得各写一遍（审批条丢了边框 1.56:1、选中胶囊消失 1.00:1、过程卡白板 2.29:1，都是这么来的）：" + hexAsFill.join("、"));
  // 反向对照：三起真事故的原样写法，一条都不许放过（注意它们一个比一个不花）
  const f1 = []; scanHexAsFill(".x { background: #fff7ed; }", "假1", f1);
  const f2 = []; scanHexAsFill(".y { border: 1px solid #fdba74; }", "假2", f2);
  const f8 = []; scanHexAsFill(".z.active { background: #17181c; }", "假3", f8);
  const f9 = []; scanHexAsFill(".w { background: #fbfcfe; }", "假4", f9);
  assert(f1.length === 1 && f2.length === 1 && f8.length === 1 && f9.length === 1,
    `写死的底色/边框抓不到，这道闸是摆设：淡橙=${f1.length} 橙边=${f2.length} 近黑=${f8.length} 近白=${f9.length}`);
  // 正向对照：var 兜底、纯黑白、以及归另一道闸管的 color: 一个都不许误报
  const f3 = [];
  scanHexAsFill(".a { background: color-mix(in srgb, var(--owb-warn, #d97706) 10%, transparent); }", "真1", f3);
  scanHexAsFill(".b { background: #fff; } .b2 { background: #000; } .b3 { border: 1px solid #FFFFFF; }", "真2", f3);
  scanHexAsFill(".c { color: #16a34a; }", "真3", f3);
  assert(f3.length === 0, "误伤了 var 兜底/纯黑白/文字色：" + f3.join("、"));
  // 免死名单只免它自己：同样的颜色换个选择器照样抓
  const f4 = []; scanHexAsFill(".code-head { background: #23252e; }", "免", f4);
  const f5 = []; scanHexAsFill(".panel { background: #23252e; }", "非免", f5);
  assert(f4.length === 0 && f5.length === 1, `免死名单跑偏了：免=${f4.length} 非免=${f5.length}`);
  // 折行写的规则：选择器在上一行，声明在下一行——按行取就读不到免死名单，会误报
  const f6 = []; scanHexAsFill("#drop { position: absolute;\n    background: #7fc4f5; }", "免折行", f6);
  const f7 = []; scanHexAsFill(".x { position: absolute;\n    background: #7fc4f5; }", "非免折行", f7);
  assert(f6.length === 0 && f7.length === 1, `折行规则认不出选择器：免=${f6.length} 非免=${f7.length}`);
  console.log(`✅ CSS 令牌闸门：${defined.size} 个变量全部有定义 · 填充色没被当文字色用（令牌写死/插值/存变量 + 写死十六进制）· 底色和边框也不许写死十六进制（五种写法都盯）`);
}

module.exports = testCssTokenGate;
if (require.main === module) testCssTokenGate();
