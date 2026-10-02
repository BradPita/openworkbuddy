// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 模板里的 __填空__：怎么认、怎么填、Tab 怎么跳、「设为填空」怎么包。
 * public/js/app-05-blanks.js 的上半截是纯函数，整个文件丢进空的 vm 里跑（下半截碰页面的那几行
 * 只在被调用时才碰 document，最后那句挂 Tab 也先看 inputEl 在不在）。
 * 内置的 14 条模板也一起过一遍：每个空都得认成一格像样的名字，不能出现「…」「10」这种标签。
 *
 * 跑法：node test/tpl-blanks.js
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "public/js/app-05-blanks.js"), "utf8");
const F = vm.runInNewContext(SRC + "\n;({ blankSpec, blankFields, blankFill, blankLeft, blankNext, blankToggle })", {});

let pass = 0, fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) { pass++; console.log("  ✅ " + msg); }
  else { fail++; console.log("  ❌ " + msg + (detail === undefined ? "" : "：" + JSON.stringify(detail).slice(0, 400))); }
};
const pick = (o, ks) => Object.fromEntries(ks.map((k) => [k, o[k]]));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log("【认】一个空长什么样");
{
  const cases = [
    ["产品名", { label: "产品名", kind: "text", def: "" }],
    ["页数=10", { label: "页数", kind: "num", def: "10" }],
    ["10", { label: "数字", kind: "num", def: "10" }],
    ["图表=折线/柱状/饼图/散点", { label: "图表", kind: "pick", def: "折线" }],
    ["折线/柱状", { label: "选一个", kind: "pick", def: "折线" }],
    ["任务描述，越具体越好：要什么、给谁看", { label: "任务描述", kind: "long", def: "" }],
    ["要整理的内容（工作区里的文件名，或直接粘贴）", { label: "要整理的内容", kind: "long", def: "" }],
    ["粘贴记录", { label: "粘贴记录", kind: "long", def: "" }],
    ["…", { label: "补充内容", kind: "long", def: "" }],
    ["", { label: "补充内容", kind: "long", def: "" }],
    ["语气=轻松", { label: "语气", kind: "text", def: "轻松" }],
    // 斜杠两边带空格、或一段太长：是一句话，不是选项
    ["工作区里的 XX 文件 / 下面这段内容", { label: "工作区里的 XX 文件 / 下面这段内容", kind: "long", def: "" }],
  ];
  for (const [raw, want] of cases) {
    const got = pick(F.blankSpec(raw), ["label", "kind", "def"]);
    ok(same(got, want), `__${raw}__ → ${want.kind}「${want.label}」`, got);
  }
  ok(F.blankSpec("任务描述，越具体越好").hint === "越具体越好", "逗号后面那段当提示");
  ok(F.blankSpec("要整理的内容（文件名，或直接粘贴）").hint === "文件名，或直接粘贴", "括号里那段当提示，右括号去掉");
  ok(same(F.blankSpec("图表=折线/柱状").options, ["折线", "柱状"]), "选项拆出来");
}

console.log("\n【认】一整段里有哪些空");
{
  const t = "给 __客户__ 出报价，__客户__ 的预算 __预算=5万__，用 __语气=正式/轻松__ 的口吻";
  const fs1 = F.blankFields(t);
  ok(same(fs1.map((f) => f.label), ["客户", "预算", "语气"]), "按出现顺序，同名只算一个", fs1.map((f) => f.label));
  ok(F.blankLeft(t) === 3, "还剩 3 个空");
  ok(F.blankFields("没有空的模板").length === 0, "没有空：一格都没有");
  ok(F.blankFields("变量 snake_case 和 __init__").length === 1, "代码里单个下划线不算；__init__ 这种认成一个空（老规矩就这样）");
  ok(F.blankFields("跨行 __不\n算__").length === 0, "不跨行");
}

console.log("\n【填】");
{
  const t = "给 __客户__ 出报价，__客户__ 的预算 __预算=5万__";
  ok(F.blankFill(t, { "客户": "老王", "预算=5万": "8万" }) === "给 老王 出报价，老王 的预算 8万", "同名的一次填满");
  ok(F.blankFill(t, { "客户": "老王", "预算=5万": "  " }) === "给 老王 出报价，老王 的预算 __预算=5万__", "空白算没填，原样留着");
  ok(F.blankFill(t, {}) === t, "什么都没给：原样");
  ok(F.blankFill("__ 客户 __", { "客户": "A" }) === "A", "两头带空格的原文也按 trim 后认");
  ok(F.blankFill("__a__", { a: "$& $1" }) === "$& $1", "值里的 $& 不被 replace 当替换模式");
}

console.log("\n【Tab】下一个空");
{
  const t = "A __x__ B __y__ C";
  //         0123456789012345
  ok(same(F.blankNext(t, 0, 0, false), [2, 7]), "开头按 Tab：第一个");
  ok(same(F.blankNext(t, 2, 7, false), [10, 15]), "正选着第一个：跳第二个");
  ok(same(F.blankNext(t, 10, 15, false), [2, 7]), "最后一个之后绕回第一个");
  ok(same(F.blankNext(t, 4, 4, false), [10, 15]), "光标在第一个中间：跳第二个");
  ok(same(F.blankNext(t, 10, 15, true), [2, 7]), "Shift+Tab：上一个");
  ok(same(F.blankNext(t, 2, 7, true), [10, 15]), "第一个上面绕到最后一个");
  ok(F.blankNext("没有空", 0, 0, false) === null, "没有空：null，Tab 照旧");
  ok(same(F.blankNext("__x__", 0, 5, false), [0, 5]), "只有一个空且正选着：还是它，不报错");
}

console.log("\n【设为填空】");
{
  const t = "帮我写 产品名 的介绍";
  let r = F.blankToggle(t, 4, 7);
  ok(r.text === "帮我写 __产品名__ 的介绍" && r.text.slice(r.start, r.end) === "产品名", "选中一段：包成空，选区落在名字上", r);
  r = F.blankToggle(r.text, r.start, r.end);
  ok(r.text === t, "再点一次：拆回来", r);
  r = F.blankToggle("帮我写 __产品名__ 的介绍", 7, 7);
  ok(r.text === t, "光标在空里面：也是拆", r);
  r = F.blankToggle(t, 3, 8);
  ok(r.text === "帮我写 __产品名__ 的介绍", "选多了两头的空格：空格留在外面", r);
  r = F.blankToggle("abc", 3, 3);
  ok(r.text === "abc__填空__" && r.text.slice(r.start, r.end) === "填空", "什么都没选：插一个 __填空__，选中「填空」接着打", r);
  r = F.blankToggle("a_b_c", 0, 5);
  ok(r.text === "__abc__", "选区里本来的下划线去掉，不然拆成两半", r);
  r = F.blankToggle("第一行\n第二行", 0, 7);
  ok(!r.text.includes("\n") && F.blankFields(r.text).length === 1, "跨行的选区并成一行，才认得出来", r);
  r = F.blankToggle("   ", 0, 3);
  ok(r.text === "   ", "只选了空白：不动");
  r = F.blankToggle("x __a__ y", 2, 2);
  ok(r.text === "x __填空__ __a__ y" || r.text.startsWith("x __填空__"), "光标贴在空的外沿：算外面，插新的", r);
}

console.log("\n【内置模板】每个空都认成像样的一格");
{
  const src = fs.readFileSync(path.join(ROOT, "public/js/app-05.js"), "utf8");
  const body = src.slice(src.indexOf("const PROMPT_TPLS"), src.indexOf("];", src.indexOf("const PROMPT_TPLS")) + 2);
  const P = vm.runInNewContext(body.replace("const PROMPT_TPLS", "PROMPT_TPLS") + ";PROMPT_TPLS", {});
  ok(Array.isArray(P) && P.length === 14, "取到 14 条", P && P.length);
  const bad = [];
  for (const t of P) {
    for (const f of F.blankFields(t.p)) {
      if (["补充内容", "数字", "选一个"].includes(f.label) || f.label.length > 12) bad.push(`${t.id}: ${f.raw}`);
    }
  }
  ok(bad.length === 0, "没有没名字的空、没有一整句当名字的空", bad);
  const ppt = P.find((t) => t.id === "b-office-ppt");
  const pf = F.blankFields(ppt.p);
  ok(pf.some((f) => f.label === "页数" && f.def === "10") && pf.some((f) => f.kind === "long"), "PPT：页数默认 10，要整理的内容给多行框", pf);
  const ch = F.blankFields(P.find((t) => t.id === "b-data-chart").p).find((f) => f.kind === "pick");
  ok(ch && ch.label === "图表" && ch.options.length === 4, "画图：图表四选一", ch);
  const dash = F.blankFields(P.find((t) => t.id === "b-web-dashboard").p).map((f) => f.label);
  ok(dash.includes("主区域放什么") && dash.includes("侧边放什么"), "工作台：主区域、侧边是两个空，不再并成一个", dash);
}

console.log(`\n${pass} 过 / ${fail} 挂`);
process.exit(fail ? 1 : 0);
