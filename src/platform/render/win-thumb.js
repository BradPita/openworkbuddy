// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 OpenWorkBuddy Contributors · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * Windows 上的文档封面：PDF、Word、Excel、PPT 的第一页。macOS 那边是 ql-thumb.js（Quick Look），
 * Windows 没有 qlmanage，按下面三步找，哪一步出图就用哪一步（cheap-first ladder：越便宜的越先试）：
 *
 * 1. 资源管理器自己的缩略图（nativeImage.createThumbnailFromPath，读系统缩略图缓存）。
 *    装了 Office / 能预览 PDF 的阅读器，资源管理器大图标里看到什么，这里就拿到什么。
 *    只有桌面版有（本进程是主进程就直接调，在服务子进程里就过桥问主进程要）；系统说没有缩略图就往下走。
 * 2. docx / xlsx / pptx 包里自带的 docProps/thumbnail.(png|jpeg)：Office「保存预览图」、WPS、
 *    PowerPoint 默认都会写一张。不用起任何进程，纯 node 起的服务也有。
 * 3. PDF：系统自带的 Windows.Data.Pdf（Win10 起都有）画第一页，借 Windows PowerShell 5.1 调。
 *    路径用单引号字面量拼进脚本、整段走 -EncodedCommand，中文路径和带引号的文件名都不会断。
 *
 * 跟 ql-thumb 一样：不是 Windows、跑挂了、超时了、没出图，一律回 null，资料库那边就给图标卡。
 * 子进程走 ql-thumb 的 runQuiet：低优先级、隐藏窗口、到点连进程一起杀（quiet-lane spawn）。
 */
const fs = require("fs");
const fsp = fs.promises;
const os = require("os");
const path = require("path");
const { runQuiet, isPng } = require("./ql-thumb");

// 资料库在 Windows 上给哪些后缀排封面。.key / .pages / .numbers 在 Windows 上谁都画不出来，不排
const WIN_COVER_RE = /\.(pdf|docx?|xlsx?|pptx?|rtf|tiff?)$/i;
const OOXML_RE = /\.(docx|xlsx|pptx|docm|xlsm|pptm)$/i;
const DEFAULT_TIMEOUT_MS = 8000;
const ZIP_MAX_BYTES = 200 * 1024 * 1024; // 再大的包整个读进内存只为一张缩略图，不值
const POWERSHELL = "powershell.exe";     // 5.1：pwsh 7 调不了 WinRT 的 Windows.Data.Pdf

/**
 * @param {string} file
 * @param {{size?: number, timeoutMs?: number, signal?: AbortSignal|null, platform?: string,
 *   spawn?: Function, shell?: ((abs: string, size: number) => Promise<Buffer|null>)|null, tmpRoot?: string}} [opts]
 *   shell：第 1 步换成假的（测试用）；传 null 就跳过第 1 步。spawn / platform / tmpRoot 同 ql-thumb。
 * @returns {Promise<Buffer|null>} PNG 或 JPEG；出不来就是 null
 */
async function winThumb(file, opts = {}) {
  const platform = opts.platform || process.platform;
  if (platform !== "win32") return null;
  const signal = opts.signal || null;
  if (signal && signal.aborted) return null;
  const abs = path.resolve(String(file || ""));
  if (!WIN_COVER_RE.test(abs)) return null;
  let st;
  try { st = await fsp.stat(abs); if (!st.isFile() || st.size === 0) return null; } catch { return null; }
  const size = clamp(Math.round(Number(opts.size) || 640), 16, 2048);
  const timeoutMs = clamp(Number(opts.timeoutMs) || DEFAULT_TIMEOUT_MS, 200, 120000);
  const t0 = Date.now();
  const left = () => timeoutMs - (Date.now() - t0);

  const shell = opts.shell === undefined ? shellThumb : opts.shell;
  if (shell) {
    const buf = await withTimeout(shell(abs, size), Math.min(left(), 4000)).catch(() => null);
    if (isImage(buf)) return buf;
  }
  if (signal && signal.aborted) return null;
  if (OOXML_RE.test(abs) && st.size <= ZIP_MAX_BYTES) {
    const buf = await zipThumb(abs).catch(() => null);
    if (isImage(buf)) return buf;
  }
  if (/\.pdf$/i.test(abs) && left() > 200) {
    return pdfFirstPage(abs, { size, timeoutMs: left(), signal, spawn: opts.spawn, tmpRoot: opts.tmpRoot });
  }
  return null;
}

/**
 * 系统缩略图。主进程里直接调 nativeImage；服务子进程里问主进程（bridge-main 的 image.fileThumb）；纯 node 没有。
 * @param {string} abs @param {number} size
 * @returns {Promise<Buffer|null>}
 */
async function shellThumb(abs, size) {
  const bridge = require("../electron-bridge");
  if (bridge.isRemote()) return bridge.toBuf(await bridge.call("image.fileThumb", { abs, size }, { timeoutMs: 5000 }));
  if (bridge.mode() !== "inproc") return null;
  return fileThumbNative(require("electron"), abs, size);
}

/**
 * 主进程那一半（bridge-main 也用它）。系统说没有缩略图时 Electron 是抛错，不是给个图标——这里收成 null。
 * @param {any} electron @param {string} abs @param {number} size
 */
async function fileThumbNative(electron, abs, size) {
  if (!electron || !electron.nativeImage || typeof electron.nativeImage.createThumbnailFromPath !== "function") return null;
  const s = clamp(Math.round(Number(size) || 640), 16, 2048);
  try {
    const img = await electron.nativeImage.createThumbnailFromPath(String(abs), { width: s, height: s });
    return img && !img.isEmpty() ? img.toPNG() : null;
  } catch { return null; }
}

/**
 * OOXML 包里自带的预览图。EMF / WMF 浏览器画不出来，不要。
 * @param {string} abs
 * @returns {Promise<Buffer|null>}
 */
async function zipThumb(abs) {
  const JSZip = require("jszip");
  const zip = await JSZip.loadAsync(await fsp.readFile(abs));
  // 正规的是 _rels/.rels 里挂的那张；兜底按常见文件名找
  let target = "";
  const rels = zip.file("_rels/.rels");
  if (rels) {
    const xml = await rels.async("string");
    const m = /<Relationship\b[^>]*Type="[^"]*\/metadata\/thumbnail"[^>]*>/i.exec(xml);
    const t = m && /Target="([^"]+)"/i.exec(m[0]);
    if (t) target = t[1].replace(/^\//, "");
  }
  const names = [target, "docProps/thumbnail.png", "docProps/thumbnail.jpeg", "docProps/thumbnail.jpg"].filter(Boolean);
  for (const n of names) {
    if (!/\.(png|jpe?g)$/i.test(n)) continue;
    const f = zip.file(n);
    if (!f) continue;
    const buf = await f.async("nodebuffer");
    if (isImage(buf)) return buf;
  }
  return null;
}

/**
 * PDF 第一页：Windows.Data.Pdf 画成 PNG（RenderToStreamAsync 缺省编码就是 PNG）。
 * 加密、损坏的 PDF 脚本会抛错退非 0，这边就是 null。
 * @param {string} abs
 * @param {{size: number, timeoutMs: number, signal?: AbortSignal|null, spawn?: Function, tmpRoot?: string}} o
 */
async function pdfFirstPage(abs, o) {
  let dir = "";
  try {
    dir = await fsp.mkdtemp(path.join(o.tmpRoot || os.tmpdir(), "owb-pdf-"));
    const script = pdfScript(abs, dir, o.size, Math.max(500, o.timeoutMs - 500));
    const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
    const r = await runQuiet(o.spawn, POWERSHELL, args, { timeoutMs: o.timeoutMs, signal: o.signal || null });
    if (r.code !== 0) return null;
    const buf = await fsp.readFile(path.join(dir, "p.png")).catch(() => null);
    return isPng(buf) ? buf : null;
  } catch {
    return null;
  } finally {
    if (dir) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** PowerShell 单引号字面量：里面只有 ' 要转义（写成 ''） */
const psq = (s) => "'" + String(s).replace(/'/g, "''") + "'";

/**
 * @param {string} src @param {string} outDir @param {number} width @param {number} waitMs
 */
function pdfScript(src, outDir, width, waitMs) {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$src = ${psq(src)}; $outDir = ${psq(outDir)}; $w = ${Math.round(width)}; $wait = ${Math.round(waitMs)}`,
    "Add-Type -AssemblyName System.Runtime.WindowsRuntime",
    "$ext = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 }",
    "$opM = $ext | Where-Object { $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1",
    "$actM = $ext | Where-Object { $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' } | Select-Object -First 1",
    "function Wait-Op($op, [Type]$t) { $task = $opM.MakeGenericMethod($t).Invoke($null, @($op)); if (-not $task.Wait($wait)) { exit 3 }; $task.Result }",
    "function Wait-Act($op) { $task = $actM.Invoke($null, @($op)); if (-not $task.Wait($wait)) { exit 3 } }",
    "$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]",
    "$null = [Windows.Storage.StorageFolder, Windows.Storage, ContentType = WindowsRuntime]",
    "$null = [Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType = WindowsRuntime]",
    "$null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]",
    "$file = Wait-Op ([Windows.Storage.StorageFile]::GetFileFromPathAsync($src)) ([Windows.Storage.StorageFile])",
    "$doc = Wait-Op ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])",
    "if ($doc.PageCount -lt 1) { exit 2 }",
    "$page = $doc.GetPage(0)",
    "$opt = New-Object Windows.Data.Pdf.PdfPageRenderOptions",
    "$opt.DestinationWidth = [uint32]$w",
    "$folder = Wait-Op ([Windows.Storage.StorageFolder]::GetFolderFromPathAsync($outDir)) ([Windows.Storage.StorageFolder])",
    "$out = Wait-Op ($folder.CreateFileAsync('p.png', [Windows.Storage.CreationCollisionOption]::ReplaceExisting)) ([Windows.Storage.StorageFile])",
    "$stream = Wait-Op ($out.OpenAsync([Windows.Storage.FileAccessMode]::ReadWrite)) ([Windows.Storage.Streams.IRandomAccessStream])",
    "Wait-Act ($page.RenderToStreamAsync($stream, $opt))",
    "$stream.Dispose(); $page.Dispose()",
    "exit 0",
  ].join("\r\n");
}

const JPEG_SIG = Buffer.from([0xff, 0xd8, 0xff]);
function isImage(buf) {
  return isPng(buf) || !!(buf && buf.length > 100 && buf.subarray(0, 3).equals(JPEG_SIG));
}

function withTimeout(p, ms) {
  let timer;
  return Promise.race([
    Promise.resolve(p),
    // 不 unref：调用方就在等这个结果，计时器得把进程吊住（finally 里会清掉）
    new Promise((resolve) => { timer = setTimeout(() => resolve(null), Math.max(0, ms)); }),
  ]).finally(() => clearTimeout(timer));
}

function clamp(v, lo, hi) {
  return Math.min(Math.max(v, lo), hi);
}

module.exports = { winThumb, zipThumb, pdfScript, fileThumbNative, isImage, WIN_COVER_RE };
