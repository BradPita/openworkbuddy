// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 OpenWorkBuddy Contributors · Commercial use requires authorization: COMMERCIAL-LICENSE.md
"use strict";
const fs = require("fs");
const path = require("path");
const { AsyncLocalStorage } = require("async_hooks");
const { dataPath } = require("./paths");

// 工作空间可切换（默认项目内 workspace/；可在设置里改成任意文件夹）
let workspaceDir = dataPath("workspace");

/**
 * 工具、连接器和任务入口共享这一个上下文，避免各自保存目录后发生跨项目串用。
 * AsyncLocalStorage 让 await、定时器和嵌套调用继续使用当前任务的根；未绑定任务时使用默认根。
 */
const wsStore = new AsyncLocalStorage();
function getWorkspaceDir() {
  return wsStore.getStore() || workspaceDir;
}
/** 在指定工作目录根下跑一段（同步或异步都行）。root 为空 = 用默认根 */
function withWorkspace(root, fn) {
  if (!root) return fn();
  return wsStore.run(path.resolve(root), fn);
}
/**
 * 在请求入口绑定后续异步链，避免为了增加上下文把整段路由再嵌套一层。
 * 只在已有请求隔离的入口使用；普通任务与嵌套调用优先使用 withWorkspace。
 */
function enterWorkspace(root) {
  if (!root) return;
  wsStore.enterWith(path.resolve(root));
}
/**
 * 全局**默认**根（= config.workspace_dir）。租户请求里 getWorkspaceDir() 返回的是租户根，
 * 所以凡是要跟「服务器的默认目录」比对、或者要写回 config 的地方，必须用这个，别用上面那个——
 * 用错了就是分公司管理员点一下设置，把总部所有人的成果目录搬走。
 */
function getDefaultWorkspaceDir() {
  return workspaceDir;
}
/** 改的是**默认**根（config.workspace_dir）。租户根不走这里，走 withWorkspace */
function setWorkspaceDir(dir, platform = process.platform) {
  if (!dir || !path.isAbsolute(dir)) throw new Error("工作空间必须是绝对路径，如 D:\\我的工作区");
  fs.mkdirSync(dir, { recursive: true }); // 无权限/非法路径会在这里抛错
  workspaceDir = winCanonCase(path.resolve(dir), platform);
  return workspaceDir;
}
/**
 * Windows：用户手敲的 d:\work 和盘上的 D:\Work 是同一个目录，字符串却不一样。存盘上真实的大小写，
 * 后面拿它跟模型给的绝对路径、跟 realpath 出来的路径比，才不会互相对不上。
 * 只认「只差大小写」的那种：realpath 还会把 subst 盘、网络盘、目录链接展开成另一条路，
 * 那是用户自己选的写法，换掉了设置页上显示的就不是用户填的那个了。别的系统原样返回
 */
function winCanonCase(p, platform = process.platform) {
  if (platform !== "win32") return p;
  try {
    const real = fs.realpathSync.native(p);
    return real.toLowerCase() === p.toLowerCase() ? real : p;
  } catch { return p; }
}

module.exports = { getWorkspaceDir, getDefaultWorkspaceDir, setWorkspaceDir, withWorkspace, enterWorkspace, winCanonCase };
