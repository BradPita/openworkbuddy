// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 OpenWorkBuddy Contributors · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * Windows 文档封面（win-thumb.js）：系统缩略图 → 包里自带的预览图 → PDF 第一页，哪步出图用哪步。
 *
 * 跑法：node test/win-thumb.js
 *
 * 任何系统上都能跑：platform 装成 win32，系统缩略图和 PowerShell 都换成假的。
 * 假 PowerShell 是一段 node 脚本：把 -EncodedCommand 解回来，从脚本里抠出 $outDir 往里写一张 PNG，
 * 证明路径真是原样（中文、单引号）进了脚本、脚本也真按它写的地方出图。
 * 真 Windows 上的 Windows.Data.Pdf 由 CI 的 Windows 那条腿跑（scripts/win-thumb-check.js）。
 */
const { mod } = require("./lib/mod");
const HOME = require("./lib/own-home")("win-thumb");

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const WT = require(mod("win-thumb"));
const libCover = require(mod("lib-cover"));

let pass = 0, fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) { pass++; console.log("  ✅ " + msg); }
  else { fail++; console.log("  ❌ " + msg + (detail === undefined ? "" : "：" + JSON.stringify(detail))); }
};

function makePng(w, h) {
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = require("crypto").randomBytes((w * 3 + 1) * h); for (let y = 0; y < h; y++) raw[y * (w * 3 + 1)] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const PNG = makePng(40, 30);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]);

async function pptx(file, thumb) {
  const JSZip = require("jszip");
  const z = new JSZip();
  z.file("[Content_Types].xml", "<Types/>");
  if (thumb) {
    z.file("_rels/.rels", `<Relationships><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail" Target="${thumb.target}"/></Relationships>`);
    z.file(thumb.target.replace(/^\//, ""), thumb.buf);
  }
  fs.writeFileSync(file, await z.generateAsync({ type: "nodebuffer" }));
}

/** 假 PowerShell：解出脚本，按 $outDir 写一张 PNG（或按文件名装坏） */
function fakePowershell(log) {
  const cp = require("child_process");
  return (cmd, args, opts) => {
    const script = Buffer.from(args[args.indexOf("-EncodedCommand") + 1], "base64").toString("utf16le");
    log.push({ cmd, args, script, opts });
    const m = /\$outDir = '((?:[^']|'')*)'/.exec(script);
    const out = m ? m[1].replace(/''/g, "'") : "";
    const bad = /坏的/.test(script) ? 1 : 0;
    const code = `if (${bad}) process.exit(1); require("fs").writeFileSync(${JSON.stringify(path.join(out, "p.png"))}, Buffer.from(${JSON.stringify(PNG.toString("base64"))}, "base64"));`;
    return cp.spawn(process.execPath, ["-e", code], opts);
  };
}

let finished = false;
process.on("exit", (code) => { if (!finished && code === 0) { console.log("  ❌ 没跑完进程就空了（有 promise 永远不回）"); process.exitCode = 1; } });

(async () => {
  const dir = path.join(HOME, "文档 'x'");
  fs.mkdirSync(dir, { recursive: true });

  console.log("\n① 不是 Windows：一律 null，什么都不碰");
  {
    const f = path.join(dir, "a.pdf"); fs.writeFileSync(f, "%PDF-1.4 假的");
    let touched = 0;
    const r = await WT.winThumb(f, { platform: "darwin", shell: async () => { touched++; return PNG; }, spawn: () => { touched++; } });
    ok(r === null && touched === 0, "darwin：null，系统缩略图和子进程都没碰", { r: !!r, touched });
    const r2 = await WT.winThumb(f, { platform: "linux", shell: async () => PNG });
    ok(r2 === null, "linux：null");
  }

  console.log("\n② 系统缩略图有就用它，后面两步都不走");
  {
    const f = path.join(dir, "b.pdf"); fs.writeFileSync(f, "%PDF-1.4 假的");
    const log = [];
    const r = await WT.winThumb(f, { platform: "win32", shell: async () => PNG, spawn: fakePowershell(log) });
    ok(r && r.equals(PNG) && log.length === 0, "拿到的就是系统那张，PowerShell 0 次", log.length);
    const r2 = await WT.winThumb(f, { platform: "win32", shell: async () => Buffer.from("不是图"), spawn: fakePowershell(log), tmpRoot: HOME });
    ok(r2 && r2.equals(PNG) && log.length === 1, "★反向对照★ 系统给的不是图：往下走到 PDF 那步", log.length);
    const r3 = await WT.winThumb(f, { platform: "win32", shell: () => new Promise(() => {}), spawn: fakePowershell(log), timeoutMs: 6000, tmpRoot: HOME });
    ok(r3 && log.length === 2, "系统缩略图挂住不回：最多等 4 秒就往下走", log.length);
  }

  console.log("\n③ docx / xlsx / pptx：包里自带的预览图");
  {
    const a = path.join(dir, "c.pptx"); await pptx(a, { target: "docProps/thumbnail.jpeg", buf: JPEG });
    const ra = await WT.winThumb(a, { platform: "win32", shell: null });
    ok(ra && ra.equals(JPEG), "按 _rels/.rels 挂的那张取（JPEG 也算）");
    const b = path.join(dir, "d.docx"); await pptx(b, { target: "/docProps/thumbnail.png", buf: PNG });
    ok((await WT.zipThumb(b)).equals(PNG), "Target 带前导 / 也认");
    const c = path.join(dir, "e.xlsx"); await pptx(c, { target: "docProps/thumbnail.emf", buf: Buffer.alloc(300, 7) });
    ok((await WT.winThumb(c, { platform: "win32", shell: null })) === null, "EMF 浏览器画不了：null（给图标）");
    const d = path.join(dir, "f.pptx"); await pptx(d, null);
    ok((await WT.winThumb(d, { platform: "win32", shell: null })) === null, "没有预览图：null");
    const e = path.join(dir, "g.docx"); fs.writeFileSync(e, "根本不是 zip");
    ok((await WT.winThumb(e, { platform: "win32", shell: null })) === null, "坏包：null，不抛");
  }

  console.log("\n④ PDF：PowerShell 画第一页，路径原样进脚本");
  {
    const f = path.join(dir, "它's 报告.pdf"); fs.writeFileSync(f, "%PDF-1.4 假的");
    const log = [];
    const r = await WT.winThumb(f, { platform: "win32", shell: null, spawn: fakePowershell(log), size: 480, tmpRoot: HOME });
    ok(r && r.equals(PNG), "出图");
    const one = log[0] || {};
    ok(one.cmd === "powershell.exe", "用的是 Windows PowerShell 5.1（pwsh 7 调不了 WinRT）", one.cmd);
    ok(Array.isArray(one.args) && one.args.includes("-NoProfile") && one.args.includes("-NonInteractive"), "不读用户 profile、不等输入", one.args);
    ok(one.script && one.script.includes("$src = " + "'" + f.replace(/'/g, "''") + "'"), "中文和单引号的路径按 PowerShell 字面量规矩转义进去", (one.script || "").slice(0, 200));
    ok(/\$w = 480;/.test(one.script || ""), "宽度就是要的那个尺寸");
    ok(one.opts && one.opts.windowsHide === true, "子进程不弹窗");
    const left = fs.readdirSync(HOME).filter((n) => n.startsWith("owb-pdf-"));
    ok(left.length === 0, "临时目录一个不留", left);
    const g = path.join(dir, "坏的.pdf"); fs.writeFileSync(g, "x");
    ok((await WT.winThumb(g, { platform: "win32", shell: null, spawn: fakePowershell(log), tmpRoot: HOME })) === null, "脚本退非 0：null");
    const h = path.join(dir, "h.doc"); fs.writeFileSync(h, "x");
    const n0 = log.length;
    ok((await WT.winThumb(h, { platform: "win32", shell: null, spawn: fakePowershell(log) })) === null && log.length === n0, ".doc 没有系统缩略图：null，不起 PowerShell");
    ok((await WT.winThumb(path.join(dir, "不存在.pdf"), { platform: "win32", shell: null, spawn: fakePowershell(log) })) === null && log.length === n0, "文件不在：null，不起 PowerShell");
  }

  console.log("\n⑤ 脚本本身");
  {
    const s = WT.pdfScript("C:\\a'b\\c.pdf", "C:\\t", 320, 5000);
    ok(s.includes("$src = 'C:\\a''b\\c.pdf'"), "单引号写成两个");
    ok(/RenderToStreamAsync/.test(s) && /DestinationWidth/.test(s) && /GetPage\(0\)/.test(s), "画的是第一页、按宽度缩放");
    ok(/\$ErrorActionPreference = 'Stop'/.test(s), "出错就停（退非 0），不带着半张图退 0");
  }

  console.log("\n⑥ 资料库：win32 的真渲染器接的是 win-thumb，两边认的后缀是同一把尺子");
  {
    const r = libCover.defaultRenderers("win32");
    ok(typeof r.office === "function", "win32 有 office 车道");
    ok(String(libCover.WIN_COVER_RE) === String(WT.WIN_COVER_RE), "lib-cover 排队的后缀 = win-thumb 画得了的后缀", [String(libCover.WIN_COVER_RE), String(WT.WIN_COVER_RE)]);
  }

  finished = true;
  console.log(`\n${fail ? "✗" : "✓"} Windows 文档封面：${pass} 过 / ${fail} 挂`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
