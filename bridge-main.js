// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 服务进程 ↔ 桌面主进程 的桥（主进程这一半）。另一半在 electron-bridge.js。
 *
 * 2026-09-29：服务端挪进 utilityProcess 以后，dialog / shell / clipboard / nativeImage /
 * BrowserWindow / powerSaveBlocker 这些只有主进程才有的东西，服务进程一律发消息过来要。
 * 这里只做「收到什么就调什么」，不做任何业务判断——业务留在 server.js / tools.js 里，
 * 两种跑法（inproc / utility）的行为才不会分叉。
 *
 * 消息形状：
 *   {t:"call", id, op, args}  → 回 {t:"ret", id, ok, value | error}
 *   {t:"note", op, args}      → 不回（宠物动作、快捷键、全屏、审批提醒、按住不睡）
 *
 * impl 可以整张换掉：test/electron-bridge.js 拿假 electron 跑每一个 op 的来回。
 */

/**
 * @param {{
 *   electron: any,
 *   getWin?: () => any,
 *   pet?: any,                 // 宠物对象，或者现取它的函数
 *   registerShortcuts?: (s: any) => void,
 *   relaunch?: () => void,
 *   onApproval?: (m: any) => void,
 *   bootLog?: (...a: any[]) => void,
 *   hidden?: boolean,
 *   impl?: Record<string, (args: any) => any>,
 * }} o
 */
function createShellBridge({ electron, getWin, pet, registerShortcuts, relaunch, onApproval, bootLog, hidden = false, impl } = /** @type {any} */ ({})) {
  const log = typeof bootLog === "function" ? bootLog : () => {};
  const counts = { calls: 0, notes: 0, errors: 0 };
  /** @type {Map<number, any>} 动效渲染的离屏窗口（motion.*），按 sid 管 */
  const motions = new Map();
  let motionSeq = 0;
  let powerId = null;

  // 宠物在服务进程起来之后才建（它一出生就要拿主窗口），所以可以传一个现取的函数
  const petOf = () => { try { return typeof pet === "function" ? pet() : pet; } catch { return null; } };
  const win = () => {
    try { const w = getWin && getWin(); return w && !w.isDestroyed() ? w : null; } catch { return null; }
  };
  const toBuf = (v) => require("./electron-bridge").toBuf(v);
  // 测试宿主（OWB_SHELL_HIDDEN=1）不弹系统框：弹出来就挡在用户桌面上，而且没人去点
  const noDialog = (op) => {
    if (!hidden) return;
    const e = /** @type {any} */ (new Error(`隐藏运行（OWB_SHELL_HIDDEN=1）时不弹系统对话框（${op}）`));
    e.code = "NO_DIALOG";
    throw e;
  };
  const motion = (sid) => {
    const d = motions.get(sid);
    if (!d) throw new Error(`动效渲染窗口 ${sid} 已经关了`);
    return d;
  };

  /** @type {Record<string, (args: any) => any>} */
  const calls = {
    "dialog.openDirectory": async (a) => {
      noDialog("dialog.openDirectory");
      const opts = { properties: ["openDirectory"], title: (a && a.title) || undefined };
      const w = win();
      return w ? electron.dialog.showOpenDialog(w, opts) : electron.dialog.showOpenDialog(opts);
    },
    "dialog.saveAs": async (opts) => {
      noDialog("dialog.saveAs");
      const w = win();
      const r = w ? await electron.dialog.showSaveDialog(w, opts || {}) : await electron.dialog.showSaveDialog(opts || {});
      return { canceled: !!r.canceled, filePath: r.filePath || "" };
    },
    "shell.showItemInFolder": async (a) => { electron.shell.showItemInFolder(String(a && a.path)); return true; },
    "clipboard.writeBuffer": async (a) => {
      const buf = toBuf(a && a.data);
      if (!buf) throw new Error("剪贴板数据是空的（clipboard.writeBuffer）");
      electron.clipboard.writeBuffer(String(a.format), buf);
      return true;
    },
    // 口径跟 server.js /api/cache/clear 在主进程里那三步一样：Cookie、localStorage 不动
    "session.clearCaches": async () => {
      const ses = electron.session.defaultSession;
      await ses.clearCache();
      try { await ses.clearCodeCaches({}); } catch {}
      try { await ses.clearStorageData({ storages: ["shadercache", "cachestorage"] }); } catch {}
      return true;
    },
    // 口径跟 server.js 宠物工具在主进程里那段一样：中心裁方、320、GIF 只取第一帧
    "image.petPhoto": async (a) => {
      const abs = String(a && a.abs);
      let img = electron.nativeImage.createFromPath(abs);
      if (img.isEmpty()) return { empty: true };
      let note = "";
      const sz = img.getSize();
      const side = Math.min(sz.width, sz.height);
      if (sz.width !== sz.height) {
        img = img.crop({ x: Math.round((sz.width - side) / 2), y: Math.round((sz.height - side) / 2), width: side, height: side });
        note += `原图 ${sz.width}×${sz.height} 不是正方形，已按中心裁成方图；`;
      }
      img = img.resize({ width: 320, height: 320, quality: "best" });
      if (/\.gif$/i.test(abs)) note += "GIF 只取了第一帧（宠物自己带呼吸/跳跃动效）；";
      return { png: img.toPNG(), note };
    },
    "image.thumb": async (a) => require("./thumb").makeThumb(String(a && a.abs), Number(a && a.w)) || null,
    "image.shrinkForVision": async (a) => {
      const maxEdge = Number(a && a.maxEdge) || 1568;
      let img = electron.nativeImage.createFromPath(String(a && a.abs));
      if (img.isEmpty()) return { empty: true };
      const sz = img.getSize();
      if (Math.max(sz.width, sz.height) > maxEdge) {
        img = img.resize(sz.width >= sz.height ? { width: maxEdge, quality: "good" } : { height: maxEdge, quality: "good" });
      }
      return { jpg: img.toJPEG(Number(a && a.quality) || 82), width: sz.width, height: sz.height };
    },
    "page.check": async (a) => require("./web-window").probePage(electron, String(a && a.file)),
    "page.render": async (a) => require("./web-window").readRendered(electron, String(a && a.url), {
      waitMs: a && a.waitMs, maxWaitMs: a && a.maxWaitMs, ua: (a && a.ua) || "",
    }),
    "shot.html": async (a) => require("./htmlshot").renderHtmlToPng(String(a && a.htmlPath), (a && a.opts) || {}),
    "svg.png": async (a) => require("./browser-render").svgToPng(String(a && a.svg), Number(a && a.scale) || 2),
    "mermaid.render": async (a) => require("./browser-render").renderMermaid(String(a && a.source), (a && a.theme) || undefined),
    "motion.open": async (a) => {
      const d = await require("./htmlvideo").electronDriver({ width: a.width, height: a.height, runtime: a.runtime });
      const sid = ++motionSeq;
      motions.set(sid, d);
      return sid;
    },
    "motion.load": async (a) => { await motion(a.sid).load(String(a.url)); return true; },
    "motion.eval": async (a) => motion(a.sid).evaluate(String(a.expr)),
    // BGRA 裸像素原样回去：nativeImage 过不了进程，要 PNG 那边自己编（electron-bridge.bgraToPng）
    "motion.capture": async (a) => (await motion(a.sid).capture()).buf,
    "motion.close": async (a) => {
      const d = motions.get(a && a.sid);
      motions.delete(a && a.sid);
      if (d) await d.close();
      return true;
    },
  };

  /** @type {Record<string, (args: any) => void>} */
  const notes = {
    "app.relaunch": () => { if (relaunch) relaunch(); },
    "pet.setState": (a) => { const p = petOf(); if (p) p.setState(a && a.state, a && a.text); },
    "pet.alertAsk": (a) => { const p = petOf(); if (p) p.alertAsk(a && a.question); },
    "pet.clearAsk": (a) => { const p = petOf(); if (p) p.clearAsk(a && a.stillWorking); },
    "pet.applyConfig": (a) => { const p = petOf(); if (p) p.applyConfig(a || {}); },
    "pet.show": () => { const p = petOf(); if (p) p.show(); },
    "pet.hide": () => { const p = petOf(); if (p) p.hide(); },
    "shortcuts.register": (a) => { if (registerShortcuts) registerShortcuts(a || {}); },
    "win.setFullScreen": (a) => { const w = win(); if (w) w.setFullScreen(!!(a && a.on)); },
    "approval.open": (a) => { if (onApproval) onApproval(a); },
    // 按住不睡（awake.js）：服务进程里没有 powerSaveBlocker，引用计数在那边，这边只按一个
    "power.hold": () => {
      if (powerId !== null) return;
      try { powerId = electron.powerSaveBlocker.start("prevent-app-suspension"); } catch { powerId = null; }
    },
    "power.release": () => releasePower(),
    "motion.hang": (a) => { const d = motions.get(a && a.sid); if (d) d.hang(); },
  };

  function releasePower() {
    if (powerId === null) return;
    try { if (electron.powerSaveBlocker.isStarted(powerId)) electron.powerSaveBlocker.stop(powerId); } catch {}
    powerId = null;
  }

  const table = impl ? { ...calls, ...impl } : calls;

  /**
   * @param {any} msg
   * @param {(m: any) => void} post 回信的出口（utilityProcess.postMessage）
   * @returns {boolean} 认不认得这条消息
   */
  function handle(msg, post) {
    if (!msg || typeof msg !== "object") return false;
    if (msg.t === "note") {
      counts.notes++;
      const fn = (impl && impl[msg.op]) || notes[msg.op];
      if (!fn) { log(`▲ 服务进程发来一个不认识的通知：${msg.op}`); return true; }
      try { fn(msg.args); } catch (e) { log(`▲ 通知 ${msg.op} 出错：${String((e && /** @type {any} */ (e).message) || e)}`); }
      return true;
    }
    if (msg.t !== "call") return false;
    counts.calls++;
    const reply = (m) => { try { post(m); } catch {} }; // 服务进程已经没了：回信扔掉就是
    const fn = table[msg.op];
    if (!fn) {
      counts.errors++;
      reply({ t: "ret", id: msg.id, ok: false, error: { message: `桌面主进程不认识这个操作（${msg.op}）`, code: "NO_OP" } });
      return true;
    }
    Promise.resolve()
      .then(() => fn(msg.args))
      .then(
        (value) => reply({ t: "ret", id: msg.id, ok: true, value: value === undefined ? null : value }),
        (e) => {
          counts.errors++;
          reply({ t: "ret", id: msg.id, ok: false, error: require("./electron-bridge").serializeError(e) });
        }
      );
    return true;
  }

  /** 服务进程没了（崩了 / 重启 / 退回主进程）：它按着的东西都得松开，别留一个不让睡的断言、一堆离屏窗口 */
  function reset() {
    releasePower();
    for (const [sid, d] of motions) {
      motions.delete(sid);
      try { Promise.resolve(d.close()).catch(() => {}); } catch {}
    }
  }

  return { handle, reset, counts, _motions: motions, get powerHeld() { return powerId !== null; } };
}

module.exports = { createShellBridge };
