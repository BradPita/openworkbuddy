// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 开发壳的启动日志（~/Library/Logs/OpenWorkBuddy.log）要轮转。
 *
 * 2026-09-28 实测：scripts/make-mac-app.sh 生成的入口只会往这个文件后面续，从不截断，
 * 当时已经 47 万字节还在涨。现在启动时超过 20MB 就挪成 .1，原来的 .1 挪成 .2，更早的不留。
 *
 * 钉三件事：
 *   1. 轮转那几行在 createWriteStream **之前**（之后才挪，新日志就写进 .1 里了）。
 *   2. 那几行里没有 $、反引号、反斜杠——入口是 bash 的 <<JS 不带引号的 heredoc 生成的，
 *      这几个字符会被 bash 吃掉或改写，生成出来的 JS 就不是写的那样了。
 *   3. 真跑一遍：大的挪、小的不动、没有文件不炸、只留两代。
 * macOS 上再真跑一次 make-mac-app.sh（对着假的 Electron.app 骨架、输出到临时目录），
 * 从**生成出来的** main.js 里抠那几行再跑一遍，验的是产物而不是脚本文本。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { execFileSync } = require("child_process");

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra != null ? "\n      " + String(extra).replace(/\n/g, "\n      ") : "")); }
}
const eq = (a, b, name) => ok(a === b, name, `实到 ${JSON.stringify(a)}，该是 ${JSON.stringify(b)}`);

const SCRIPT = path.join(__dirname, "..", "scripts", "make-mac-app.sh");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "owb-launchlog-"));
const MB = 1024 * 1024;

/** 入口里「定下 LOG 路径 + 轮转」那一段：从 const LOG = 到打开写流之前 */
function rotateBlock(js) {
  const a = js.indexOf("const LOG = ");
  const b = js.indexOf("fs.createWriteStream(LOG");
  if (a < 0 || b < 0 || b < a) return "";
  const cut = js.lastIndexOf("\ntry {", b);
  const s = cut > a ? js.slice(a, cut) : "";
  return /renameSync\(LOG/.test(s) ? s : ""; // 写流之前那段里真有挪文件，才算「先轮转后开写」
}
/** heredoc 的正文（bash 展开之前） */
function heredoc(sh) {
  const m = sh.match(/<<JS\n([\s\S]*?)\nJS\n/);
  return m ? m[1] : "";
}
/** 在假 HOME 下跑那一段 */
function runIn(block, home) {
  new vm.Script(block).runInNewContext({ fs, path, process: { env: { HOME: home } } });
}
/** 造一个假 HOME，日志大小按 MB 给（稀疏文件，不真占磁盘） */
function mkHome(name, sizes) {
  const home = path.join(TMP, name);
  const dir = path.join(home, "Library", "Logs");
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, "OpenWorkBuddy.log");
  for (const [suffix, mb, tag] of sizes) {
    fs.writeFileSync(f + suffix, tag);
    fs.truncateSync(f + suffix, Math.round(mb * MB));
  }
  return f;
}
const head = (f) => { try { const b = Buffer.alloc(8); const fd = fs.openSync(f, "r"); fs.readSync(fd, b, 0, 8, 0); fs.closeSync(fd); return b.toString().replace(/\0+$/, ""); } catch { return null; } };

function behave(block, label) {
  // 大的：原来 .1 → .2，原来的日志 → .1，原来的 .2 不留
  const big = mkHome(label + "-big", [["", 21, "cur"], [".1", 3, "one"], [".2", 3, "two"]]);
  runIn(block, path.dirname(path.dirname(path.dirname(big))));
  eq(fs.existsSync(big), false, `★${label}：超过 20MB 的挪走了★ 新的一轮从空文件开始`);
  eq(head(big + ".1"), "cur", `${label}：刚才那份成了 .1`);
  eq(head(big + ".2"), "one", `★${label}：原来的 .1 成了 .2，最早那代不留★ 只留两代，不然轮转等于没做`);
  ok(!fs.existsSync(big + ".3"), `${label}：没有第三代`);
  // 反向对照：没到 20MB 一个字都不动
  const small = mkHome(label + "-small", [["", 19.5, "cur"], [".1", 3, "one"]]);
  runIn(block, path.dirname(path.dirname(path.dirname(small))));
  eq(head(small), "cur", `反向对照（${label}）：19.5MB 的原地不动`);
  eq(head(small + ".1"), "one", `反向对照（${label}）：它的 .1 也不动`);
  // 头一回轮转：还没有 .1
  const first = mkHome(label + "-first", [["", 25, "cur"]]);
  runIn(block, path.dirname(path.dirname(path.dirname(first))));
  eq(head(first + ".1"), "cur", `${label}：头一回超线，没有 .1 也照样挪`);
  ok(!fs.existsSync(first + ".2"), `${label}：没有 .1 可挪就不凭空造 .2`);
  // 压根没有日志 / 连目录都没有：不许炸（Finder 启动炸了就是双击没反应）
  let threw = null;
  try { runIn(block, path.join(TMP, label + "-nohome")); } catch (e) { threw = e; }
  eq(threw, null, `★${label}：日志还不存在时不抛★ 入口第一次跑就是这样`);
}

console.log("\n① 脚本里那几行");
const sh = fs.readFileSync(SCRIPT, "utf8");
const body = heredoc(sh);
ok(body.length > 0, "找得到 <<JS 那段入口");
const block = rotateBlock(body);
ok(block.length > 0, "★轮转那几行在打开写流之前★ 之后才挪的话，新日志就接着写进 .1 里了");
ok(/20 \* 1024 \* 1024/.test(block) && /renameSync\(LOG \+ "\.1", LOG \+ "\.2"\)/.test(block) && /renameSync\(LOG, LOG \+ "\.1"\)/.test(block),
  "门槛 20MB、留两代", block);
ok(!/[$`\\]/.test(block), "★那几行里没有 $、反引号、反斜杠★ <<JS 不带引号，bash 会把它们改掉", block);
ok(/fs\.createWriteStream\(LOG, \{ flags: "a" \}\)/.test(body), "写流打开的就是轮转过的那个路径");
// 反向对照：顺序反过来（先开写流再轮转）要认得出来
eq(rotateBlock('const LOG = "x";\ntry {\n  const log = fs.createWriteStream(LOG, { flags: "a" });\n} catch {}\ntry { fs.renameSync(LOG, LOG + ".1"); } catch {}'),
  "", "反向对照：先开写流、后轮转的写法抠不出轮转段（前面那条会红）");
ok(/[$`\\]/.test('const x = `a${b}`;'), "反向对照：同一个检查碰到模板字符串是会红的");

console.log("\n② 真跑那几行");
behave(block, "脚本原文");

console.log("\n③ 生成出来的入口");
if (process.platform !== "darwin") {
  console.log("  - 跳过：make-mac-app.sh 要 PlistBuddy/ditto，只在 macOS 上有");
} else {
  const src = path.join(TMP, "Electron.app");
  fs.mkdirSync(path.join(src, "Contents", "MacOS"), { recursive: true });
  fs.mkdirSync(path.join(src, "Contents", "Resources"), { recursive: true });
  fs.writeFileSync(path.join(src, "Contents", "MacOS", "Electron"), "#!/bin/sh\necho fake\n", { mode: 0o755 });
  fs.writeFileSync(path.join(src, "Contents", "Resources", "electron.icns"), "icns");
  const kv = { CFBundleName: "Electron", CFBundleDisplayName: "Electron", CFBundleExecutable: "Electron", CFBundleIdentifier: "com.github.Electron", CFBundleIconFile: "electron.icns", CFBundleShortVersionString: "43.2.0", CFBundleVersion: "43.2.0", CFBundlePackageType: "APPL" };
  fs.writeFileSync(path.join(src, "Contents", "Info.plist"),
    '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    '<plist version="1.0"><dict>' + Object.entries(kv).map(([k, v]) => `<key>${k}</key><string>${v}</string>`).join("") + "</dict></plist>\n");
  const out = path.join(TMP, "Applications", "OpenWorkBuddy.app");
  let log = "";
  try {
    log = execFileSync("bash", [SCRIPT], { env: { ...process.env, OWB_ELECTRON_APP: src, OWB_APP_OUT: out, OWB_SKIP_CODESIGN: "1" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) { log = String(e.stdout || "") + String(e.stderr || ""); }
  ok(/已生成/.test(log), "脚本对着假骨架跑成了", log);
  const gen = (() => { try { return fs.readFileSync(path.join(out, "Contents", "Resources", "app", "main.js"), "utf8"); } catch { return ""; } })();
  const genBlock = rotateBlock(gen);
  eq(genBlock, block, "★生成出来的轮转段跟脚本里写的一字不差★ bash 展开没动它");
  if (genBlock) behave(genBlock, "生成的入口");
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 过 / ${fail} 挂`);
process.exit(fail === 0 ? 0 : 1);
