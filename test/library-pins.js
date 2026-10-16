// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 OpenWorkBuddy Contributors · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 侧栏文件置顶清单：键只存 lib/ws + 相对路径；按账号根隔离；并发写串行；文件消失仍可从侧栏清掉。
 * 真文件都在测试自己的临时 HOME 下，不碰用户数据。
 */
const fs = require("fs");
const path = require("path");
const { mod } = require("./lib/mod");
const HOME = require("./lib/own-home")("library-pins");
const pins = require(mod("lib-pins"));

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra === undefined ? "" : "  ← " + JSON.stringify(extra).slice(0, 300))); }
};
const fresh = (name) => { const d = path.join(HOME, "unit", name); fs.mkdirSync(d, { recursive: true }); return d; };
const fileOf = (root) => path.join(root, pins.PIN_FILE);
const saved = (root) => JSON.parse(fs.readFileSync(fileOf(root), "utf8"));

(async () => {
  console.log("\n① 键规整与越界拒绝");
  ok(pins.pinKey("ws", "成果\\周报.md") === "ws:成果/周报.md", "反斜杠规整成正斜杠");
  ok(pins.pinKey("lib", "报告/周报.md") === "lib:报告/周报.md", "资料库键使用相对路径");
  for (const [src, rel] of [["other", "a.md"], ["ws", ""], ["ws", "../private"], ["ws", "/tmp/a"], ["ws", "C:\\secret"], ["ws", "a\u0001b"], ["lib", ".favorites.json"]]) {
    ok(!pins.pinKey(src, rel), "拒绝不合法键 " + src);
  }
  let bad = null;
  try { await pins.setPin(fresh("invalid"), "ws:../private", true); } catch (e) { bad = e; }
  ok(!!bad && bad.status === 400, "服务端模块拒绝越界键，未落盘");

  console.log("\n② 置顶、取消和路径保密");
  const root = fresh("basic");
  const k = "ws:交付/周报.md";
  const at1 = await pins.setPin(root, k, true, 1000);
  const at2 = await pins.setPin(root, k, true, 2000);
  ok(at1 === 1000 && at2 === 1000, "重复置顶保留第一次时间");
  ok(pins.readPins(root).items[k].at === 1000, "清单可读回这条置顶");
  ok(!fs.readFileSync(fileOf(root), "utf8").includes(root), "盘上只存相对路径，不存绝对目录");
  ok(await pins.setPin(root, k, false) === 0 && !pins.readPins(root).items[k], "取消置顶后清单删除这条");
  const noop = fresh("noop");
  ok(!(await pins.setPin(noop, k, false)) && !fs.existsSync(fileOf(noop)), "取消未置顶文件不建清单");

  console.log("\n③ 账号隔离、缺失保留和排序");
  const a = fresh("account-a"), b = fresh("account-b");
  await Promise.all([pins.setPin(a, "lib:客户/合同.pdf", true, 100), pins.setPin(a, "ws:项目/脚本.js", true, 200)]);
  ok(Object.keys(pins.readPins(a).items).length === 2 && Object.keys(pins.readPins(b).items).length === 0, "两个账号根的清单互不串");
  const listed = pins.listPins(a, (src, rel) => src === "ws" && rel === "项目/脚本.js" ? { size: 12, mtime: new Date(300) } : null);
  ok(listed.length === 2 && listed[0].key === "ws:项目/脚本.js" && listed[0].size === 12, "新置顶排前面并带当前 stat");
  ok(listed[1].missing && listed[1].name === "合同.pdf", "原文件没了仍显示 missing，便于用户取消置顶");
  await pins.setPin(a, "ws:项目/脚本.js", true, 300, "deadbeef");
  const roots = pins.listPins(a, (src, rel, rootKey) => ({ rootKey }));
  ok(roots.filter((x) => x.key === "ws:项目/脚本.js").length === 2
    && roots.some((x) => x.root === "deadbeef") && roots.some((x) => !x.root), "同一路径可在不同项目各自置顶，清单只保存不透明项目指纹");
  ok(!JSON.stringify(saved(a)).includes(a), "项目置顶身份不写入本机绝对路径");
  await pins.setPin(a, "ws:项目/版本@deadbeef", true, 400, "cafebabe");
  ok(pins.listPins(a, (src, rel) => ({ rel })).some((x) => x.path === "项目/版本@deadbeef" && x.root === "cafebabe"), "文件名以 @ 加 8 位字符结尾时仍能和项目指纹区分");

  console.log("\n④ 并发写和坏文件隔离");
  const concurrent = fresh("concurrent");
  await Promise.all(Array.from({ length: 20 }, (_, i) => pins.setPin(concurrent, "ws:批量/文件-" + i + ".txt", true, i + 1)));
  ok(Object.keys(saved(concurrent).items).length === 20, "20 个并发置顶一条不丢");
  await Promise.all(Array.from({ length: 20 }, (_, i) => pins.setPin(concurrent, "ws:批量/文件-" + i + ".txt", i !== 19, 500 + i)));
  ok(Object.keys(saved(concurrent).items).length === 19 && !saved(concurrent).items["ws:批量/文件-19.txt"], "并发置顶/取消按提交顺序串行落盘");
  const broken = fresh("broken");
  fs.writeFileSync(fileOf(broken), "not json");
  ok(Object.keys(pins.readPins(broken).items).length === 0, "坏清单按空集合继续工作");
  ok(fs.readdirSync(broken).some((n) => n.startsWith(pins.PIN_FILE + ".bad-")), "坏文件原样留底供排查");

  console.log("\n" + (fail ? "挂了 " + fail + " 条" : "全部通过") + "；" + pass + " 条断言\n");
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error(e && e.stack || e); process.exitCode = 1; });
