// SPDX-License-Identifier: MIT
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle)
"use strict";
/**
 * 装机包里 mermaid / echarts 只带一个打包好的文件。
 *
 * 量过：桌面包 node_modules 里约一万个文件，其中 mermaid 和它独占的那批依赖（d3、cytoscape、katex……）
 * 占了五千多个。可运行时真正读的只有两个文件：
 *   · browser-render.js 按路径读 mermaid/dist/mermaid.min.js，整段塞进隐藏页面去渲染——那是个自带全部依赖的单文件；
 *   · diagram.js 的 require("echarts") 按 exports.require 落到 echarts/dist/echarts.js，同样是 UMD 单文件，里面不再 require 别的包。
 * 剩下的 ESM 源码、按需拆出来的 chunk、和只被这两个包引用的依赖，装进去一个字节都不会被读。
 * Windows 上它们的代价是实打实的：装机向导要逐个写、Defender 要逐个扫，免安装版每次启动还要再解压一遍。
 *
 * 这里只算「删哪些」，不手写清单——依赖一升级手写的就过期了。规则：
 *   1) 包本身：只留 KEEP 里那几个文件，外加 package.json、许可证、NOTICE；
 *   2) 依赖：从 package-lock 算出「只有经过这两个包才走得到」的那批，整包不带。
 *      别的生产依赖也要用的一律留着（比如短剧画布直接读的 @dagrejs/dagre）；
 *   3) 被删掉的那批依赖，许可证原文在打包后汇总写进 node_modules/<包>/THIRD-PARTY-LICENSES.txt，
 *      单文件里打进了它们的代码，署名不能跟着文件一起删没。
 * 拿不到 package-lock.json 就什么都不删：包大一点，但不会删错。
 *
 * 只影响桌面安装包（electron-builder 的 files）。源码安装和 Docker 照常 npm install 全量，不受影响。
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

/**
 * 只留这几个文件的包。
 * require: false 表示 Node 这边从不 require 它（只按路径读文件），闸门就不拿 require 去验它。
 */
const BUNDLES = {
  mermaid: { keep: ["dist/mermaid.min.js"], require: false },
  echarts: { keep: ["dist/echarts.js", "dist/package.json"], require: true }, // dist/package.json 声明 commonjs，少了它 echarts.js 会被当成 ESM
};
/** 包顶层这些一律留着：package.json 是解析入口要用的，许可证和 NOTICE 是分发时必须附上的 */
const ALWAYS_KEEP = /^(package\.json|licen[cs]e.*|notice.*|licenses)$/i;
const LICENSE_FILE = /^(licen[cs]e|copying|notice)([.-].*)?$/i;
const DIGEST = "THIRD-PARTY-LICENSES.txt";

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

/** package-lock 里 "node_modules/a/node_modules/b" 的上一层 */
function parentOf(p) {
  const i = p.lastIndexOf("node_modules/");
  return i <= 0 ? "" : p.slice(0, i - 1);
}

/** 按 Node 的查找规则，从 from 这个包里 require(name) 会落到 lock 里哪一条 */
function resolveIn(lock, from, name) {
  for (let base = from; ; base = parentOf(base)) {
    const cand = (base ? base + "/" : "") + "node_modules/" + name;
    if (lock[cand]) return cand;
    if (!base) return null;
  }
}

/** 从 starts 出发走得到的全部包（含可选依赖和 peer，宁可多留） */
function closure(lock, starts) {
  const seen = new Set();
  const queue = starts.filter(Boolean);
  while (queue.length) {
    const p = queue.pop();
    if (seen.has(p)) continue;
    seen.add(p);
    const e = lock[p] || {};
    for (const n of Object.keys({ ...e.dependencies, ...e.optionalDependencies, ...e.peerDependencies })) {
      const r = resolveIn(lock, p, n);
      if (r && !seen.has(r)) queue.push(r);
    }
  }
  return seen;
}

/**
 * 算出这次打包要删什么。
 * @param {string} [root] 仓库根；测试拿假仓库做反向对照用
 * @returns {{bundles: string[], dropped: string[], droppedBy: Record<string,string[]>, skipped: string[]}}
 *   bundles 真正瘦身的包名；dropped 整包不带的 lock 路径（已去掉被上层覆盖的嵌套路径）；
 *   droppedBy 每个瘦身包名下独占的依赖（写许可证汇总用，含嵌套）；skipped 因为别的依赖也要用而没瘦的
 */
function plan(root = ROOT) {
  const empty = { bundles: [], dropped: [], droppedBy: {}, skipped: [] };
  const lockFile = readJson(path.join(root, "package-lock.json"));
  const pkg = readJson(path.join(root, "package.json"));
  const lock = lockFile && lockFile.packages;
  if (!lock || !pkg) return empty;
  const rootDeps = Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies });
  let bundles = Object.keys(BUNDLES).filter((n) => rootDeps.includes(n) && lock["node_modules/" + n] &&
    fs.existsSync(path.join(root, "node_modules", n, "package.json")));
  const skipped = [];
  // 别的生产依赖也 require 它的话，它就不是「只按单文件用」了，整包留着
  for (;;) {
    const others = closure(lock, rootDeps.filter((n) => !bundles.includes(n)).map((n) => resolveIn(lock, "", n)));
    const hit = bundles.filter((n) => others.has("node_modules/" + n));
    if (!hit.length) {
      const roots = new Set(bundles.map((n) => "node_modules/" + n));
      const droppedBy = {};
      const all = new Set();
      for (const b of bundles) {
        droppedBy[b] = [...closure(lock, ["node_modules/" + b])]
          .filter((p) => !others.has(p) && !roots.has(p))
          .sort();
        droppedBy[b].forEach((p) => all.add(p));
      }
      // 瘦身包里嵌着的 node_modules 由 bundleExcludes 按目录删，挂在别的被删包底下的随上层一起删，这里只列剩下的
      const dropped = [...all].filter((p) => fs.existsSync(path.join(root, p)) &&
        ![...all, ...roots].some((q) => p.startsWith(q + "/node_modules/"))).sort();
      return { bundles, dropped, droppedBy, skipped };
    }
    skipped.push(...hit);
    bundles = bundles.filter((n) => !hit.includes(n));
  }
}

/** 瘦身包里该删的条目（相对包目录，目录带尾斜杠）：沿 keep 路径往下走，路上不经过的兄弟一律删 */
function bundleExcludes(name, root = ROOT) {
  const dir = path.join(root, "node_modules", name);
  const keep = BUNDLES[name].keep;
  const out = [];
  const walk = (rel) => {
    let ents;
    try { ents = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const r = rel ? rel + "/" + e.name : e.name;
      if (keep.includes(r)) continue;
      if (!rel && ALWAYS_KEEP.test(e.name)) continue;
      if (e.isDirectory() && keep.some((k) => k.startsWith(r + "/"))) { walk(r); continue; }
      out.push(e.isDirectory() ? r + "/" : r);
    }
  };
  walk("");
  return out.sort();
}

/** 给 electron-builder.config.js 的 files 用的排除模式 */
function excludePatterns(root = ROOT) {
  const p = plan(root);
  const out = p.dropped.map((d) => `!${d}/**`);
  for (const b of p.bundles) {
    for (const e of bundleExcludes(b, root)) out.push(e.endsWith("/") ? `!node_modules/${b}/${e}**` : `!node_modules/${b}/${e}`);
  }
  return out;
}

function licenseOf(meta) {
  const l = meta && meta.license;
  if (typeof l === "string") return l;
  if (l && typeof l === "object" && l.type) return l.type;
  return "未声明";
}

/**
 * 打包后在 app/node_modules/<包>/ 下写一份被删依赖的许可证汇总。
 * 读的是仓库里的原包（装机包里它们已经被删了）。
 * @returns {string[]} 写了哪些文件（app 相对路径）
 */
function writeLicenseDigests(appDir, root = ROOT) {
  const p = plan(root);
  const written = [];
  for (const b of p.bundles) {
    const parts = [
      `${b} 在装机包里只带了 ${BUNDLES[b].keep[0]}，它把下面这些依赖用到的代码打进了这一个文件，这些包本身不再单独附带。`,
      `${b} ships only ${BUNDLES[b].keep[0]} in this app. That file contains code from the packages below, which are not shipped separately; their license texts follow.`,
    ];
    for (const rel of p.droppedBy[b]) {
      const dir = path.join(root, rel);
      const meta = readJson(path.join(dir, "package.json"));
      if (!meta) continue;
      parts.push("", "=".repeat(72), `${meta.name || rel.split("node_modules/").pop()}@${meta.version || "?"} — ${licenseOf(meta)}`, "=".repeat(72));
      let texts = [];
      try {
        texts = fs.readdirSync(dir).filter((f) => LICENSE_FILE.test(f) && fs.statSync(path.join(dir, f)).isFile()).sort();
      } catch {}
      if (!texts.length) parts.push(`（这个包没有附许可证原文，package.json 写的许可是 ${licenseOf(meta)}）`);
      for (const f of texts) parts.push(fs.readFileSync(path.join(dir, f), "utf8").trimEnd());
    }
    const out = path.join(appDir, "node_modules", b, DIGEST);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, parts.join("\n") + "\n");
    written.push(path.join("node_modules", b, DIGEST));
  }
  return written;
}

module.exports = { BUNDLES, ALWAYS_KEEP, DIGEST, plan, closure, resolveIn, bundleExcludes, excludePatterns, writeLicenseDigests };
