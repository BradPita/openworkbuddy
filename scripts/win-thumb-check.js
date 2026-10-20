// SPDX-License-Identifier: MIT
// Copyright (c) 2026 OpenWorkBuddy Contributors · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 在真 Windows 上验资料库的文档封面（win-thumb.js）：CI 的 Windows 那条腿跑（release.yml）。
 * test/win-thumb.js 里的 PowerShell 是假的，Windows.Data.Pdf 到底调不调得通只有这里知道。
 *
 * 现写一个一页的 PDF（文件名带中文和单引号）、一个自带预览图的 pptx，各出一张封面：
 * 出不来、不是 PNG / JPEG、PDF 那张宽度不对，就退 1。
 *
 * 跑法（只在 Windows 上有意义）：node scripts/win-thumb-check.js
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { winThumb } = require("../src/platform/render/win-thumb");

/** 一页 A4、画一块灰底黑字的最小 PDF，xref 偏移按实际字节算 */
function onePagePdf() {
  const stream = "0.85 g 50 600 495 180 re f 0 g BT /F1 36 Tf 80 680 Td (OpenWorkBuddy) Tj ET";
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let out = "%PDF-1.4\n";
  const offs = [];
  objs.forEach((o, i) => { offs.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((n) => String(n).padStart(10, "0") + " 00000 n \n").join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const pngWidth = (b) => b.readUInt32BE(16);
const kind = (b) => (b && b[0] === 0x89 && b[1] === 0x50 ? "png" : b && b[0] === 0xff && b[1] === 0xd8 ? "jpeg" : "");

(async () => {
  if (process.platform !== "win32") { console.log("不是 Windows，跳过"); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owb-wthumb-"));
  let bad = 0;
  try {
    const pdf = path.join(dir, "它's 报告.pdf");
    fs.writeFileSync(pdf, onePagePdf());
    const t0 = Date.now();
    // shell:null：纯 node 里没有 Electron，第 1 步本来就是 null；这里只验第 3 步
    const a = await winThumb(pdf, { size: 320, timeoutMs: 30000, shell: null });
    const ms = Date.now() - t0;
    if (kind(a) !== "png") { bad++; console.log(`✗ PDF 第一页没画出来（${ms}ms）`); }
    else if (pngWidth(a) !== 320) { bad++; console.log(`✗ PDF 封面宽 ${pngWidth(a)}，要的是 320`); }
    else console.log(`✓ PDF 第一页 → PNG ${pngWidth(a)}×${a.readUInt32BE(20)}，${a.length} 字节，${ms}ms`);

    const JSZip = require("jszip");
    const z = new JSZip();
    z.file("_rels/.rels", '<Relationships><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail" Target="docProps/thumbnail.png"/></Relationships>');
    if (a) z.file("docProps/thumbnail.png", a);
    const pptx = path.join(dir, "幻灯片.pptx");
    fs.writeFileSync(pptx, await z.generateAsync({ type: "nodebuffer" }));
    const b = await winThumb(pptx, { size: 320, shell: null });
    if (!kind(b)) { bad++; console.log("✗ pptx 自带的预览图没取出来"); }
    else console.log(`✓ pptx 自带预览图 → ${kind(b)}，${b.length} 字节`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
