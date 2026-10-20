// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 OpenWorkBuddy Contributors · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * Windows 安装版的应用内更新：设置 → 关于 里点「下载更新」，下完点「重启安装」。
 *
 * 只给 Windows 安装版（setup.exe 装的）开：
 * - NSIS 安装器不签名也能自己覆盖装，electron-updater 在 Windows 上不强制校验签名（没配 publisherName 就不验）。
 * - macOS 的 Squirrel.Mac 会校验代码签名，我们的包没签，硬做只会是一颗永远报错的按钮——mac 照旧走 updater.js 那条「怎么升」。
 * - 免安装版没有装过，没东西可覆盖；源码跑的 git pull。
 * 下载是增量的（patchwork download）：新包旁边发了 .blockmap，跟本机上一版的比一比，只下变了的块；比不了（第一次、缓存没了）就整包下。
 *
 * 只在用户点了才下（autoDownload 关着）：一个两百兆的包不能在人不知道的时候悄悄走流量。
 * 下好了不点「重启安装」也行：下次退出应用时自己装上（autoInstallOnAppQuit）。
 *
 * 这个模块只在 Electron 主进程里用。服务进程过桥来要（bridge-main 的 update.*），server.js 的 /api/update 那几条。
 */
const fs = require("fs");
const path = require("path");

/**
 * @param {{ app: any, platform?: string, env?: Record<string, string|undefined>, resourcesPath?: string,
 *   loadUpdater?: () => any, log?: (s: string) => void }} o
 *   loadUpdater 给测试换假的；缺省 require("electron-updater").autoUpdater
 */
function createAutoUpdate(o) {
  const platform = o.platform || process.platform;
  const env = o.env || process.env;
  const resourcesPath = o.resourcesPath === undefined ? process.resourcesPath : o.resourcesPath;
  const log = o.log || (() => {});
  /** @type {{phase: string, version: string, percent: number, transferred: number, total: number, error: string}} */
  let st = { phase: "idle", version: "", percent: 0, transferred: 0, total: 0, error: "" };
  let updater = null;
  let checkInFlight = null;

  /** 为什么不支持：空串 = 支持。给界面直接用的人话 */
  function why() {
    if (platform !== "win32") return "not-win";
    if (!o.app || !o.app.isPackaged) return "source";
    if (env.PORTABLE_EXECUTABLE_FILE) return "portable";
    // 打包时配了 publish 才会有它；没有就是老打法的包，electron-updater 会一上来就报找不到
    if (!resourcesPath || !fs.existsSync(path.join(resourcesPath, "app-update.yml"))) return "no-feed";
    return "";
  }

  function get() {
    if (updater) return updater;
    const u = o.loadUpdater ? o.loadUpdater() : require("electron-updater").autoUpdater;
    u.autoDownload = false;
    u.autoInstallOnAppQuit = true;
    u.allowPrerelease = false;
    u.allowDowngrade = false;
    u.logger = { info: (m) => log(`[更新] ${m}`), warn: (m) => log(`[更新] ${m}`), error: (m) => log(`[更新] ${m}`), debug: () => {} };
    u.on("checking-for-update", () => { st = { ...st, phase: "checking", error: "" }; });
    u.on("update-available", (info) => { st = { ...st, phase: "available", version: String((info && info.version) || "") }; });
    u.on("update-not-available", (info) => { st = { ...st, phase: "latest", version: String((info && info.version) || "") }; });
    u.on("download-progress", (p) => {
      st = { ...st, phase: "downloading", percent: Math.max(0, Math.min(100, Math.round(Number(p && p.percent) || 0))),
        transferred: Number(p && p.transferred) || 0, total: Number(p && p.total) || 0 };
    });
    u.on("update-downloaded", (info) => { st = { ...st, phase: "downloaded", percent: 100, version: String((info && info.version) || st.version) }; });
    // 原样报出来，不猜原因（网络、磁盘、杀毒都有可能）
    u.on("error", (e) => { st = { ...st, phase: "error", error: String((e && e.message) || e).split("\n")[0].slice(0, 300) }; });
    updater = u;
    return u;
  }

  const state = () => ({ supported: !why(), why: why(), ...st });

  async function check() {
    if (why()) return state();
    if (st.phase === "downloading" || st.phase === "downloaded") return state();
    if (checkInFlight) return checkInFlight;
    checkInFlight = (async () => {
      try { await get().checkForUpdates(); } catch (e) { st = { ...st, phase: "error", error: String((e && e.message) || e).split("\n")[0].slice(0, 300) }; }
      return state();
    })();
    try { return await checkInFlight; } finally { checkInFlight = null; }
  }

  /** 开始下，不等下完：进度从 state() 里看 */
  async function download() {
    if (why()) return state();
    if (st.phase === "downloading" || st.phase === "downloaded") return state();
    if (st.phase !== "available") await check();
    if (st.phase !== "available") return state();
    st = { ...st, phase: "downloading", percent: 0, error: "" };
    get().downloadUpdate().catch((e) => { st = { ...st, phase: "error", error: String((e && e.message) || e).split("\n")[0].slice(0, 300) }; });
    return state();
  }

  /** 下好了才装：退出应用、跑安装器（有界面，能看到进度）、装完自己打开 */
  function install() {
    if (why() || st.phase !== "downloaded") return { ...state(), ok: false };
    setTimeout(() => { try { get().quitAndInstall(false, true); } catch (e) { log(`[更新] 重启安装失败：${(e && e.message) || e}`); } }, 300);
    return { ...state(), ok: true };
  }

  return { why, state, check, download, install };
}

let single = null;
/** 主进程里的那一份。bridge-main 和进程内模式的 server.js 都用它 */
function shared(electron) {
  if (!single) single = createAutoUpdate({ app: electron && electron.app, log: (s) => console.log(s) });
  return single;
}

module.exports = { createAutoUpdate, shared };
