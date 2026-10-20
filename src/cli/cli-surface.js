// @ts-check
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 OpenWorkBuddy Contributors
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { openerFor } = require("./term-image");

/** Explicit terminal actions run on the host, outside the model's command sandbox. */
function openRequest(text) {
  const t = String(text || "").trim().replace(/[！!。.?？]+$/, "");
  if (!t || /\n|不要|别|不许|不能|如何|怎么|怎样|能否|是否|可不可以|can you|how (?:do|to)|don't|do not/i.test(t)) return null;
  const direct = /^(?:(?:请|麻烦|帮我|给我|你|直接|现在|再|把|一下|刚才|刚刚|做好的|做的|生成的|的|这个|那个|这份|那份|它|网站|网页|页面|文件|成果|预览|在浏览器里|在浏览器中)\s*)*打开(?:(?:一下|啊|呀|吧|呗|它|这个|那个|这份|那份|刚才|刚刚|做好的|做的|生成的|的|网站|网页|页面|文件|成果|预览|给我|看看|在浏览器里|在浏览器中)\s*)*$/;
  if (direct.test(t) || /^(?:please\s+)?open\s+(?:it|that|the (?:page|website|file|result))(?:\s+(?:please|for me|in (?:the )?browser))?$/i.test(t)) return { target: "recent" };
  const m = /^(?:(?:请|麻烦|帮我|给我|你|直接)\s*)*打开\s+(.+)$/.exec(t) || /^(?:please\s+)?open\s+(.+)$/i.exec(t);
  if (!m) return null;
  const name = m[1].replace(/^["'`]|["'`]$/g, "");
  if (/^[a-z][a-z0-9+.-]*:/i.test(name) && !/^[a-z]:[\\/]/i.test(name)) return null;
  return /\.[a-z0-9]{1,10}$/i.test(name) && !/[\x00-\x1f]/.test(name) ? { target: name } : null;
}

function currentFiles(changed, files) {
  const existing = new Set((files || []).map(f => typeof f === "string" ? f : f.name));
  return [...new Set(changed || [])].filter(n => existing.has(n));
}

function openAfterTask(text) {
  const t = String(text || "").trim();
  if (/不要打开|别打开|不许打开|不要自动|don't open|do not open/i.test(t)) return false;
  return /(?:做好|做完|完成|生成|写完)(?:之后|以后|后)?[，,\s]*(?:(?:请|帮我|给我|直接|自动|再)\s*)*打开(?:它|网站|网页|页面|文件|成果)?[啊吧呀！!。\s]*$/.test(t)
    || /(?:并|然后|顺便)[，,\s]*(?:(?:请|帮我|给我|直接|自动|再)\s*)*打开(?:它|网站|网页|页面|文件|成果)?[啊吧呀！!。\s]*$/.test(t)
    || /\b(?:then|and) open (?:it|the (?:page|website|file|result))(?: for me)?[.!\s]*$/i.test(t);
}

/** A recent page wins over ancillary assets; never guess among several deliverables. */
function recentTarget(files) {
  const list = [...new Set(files || [])];
  const pages = list.filter(n => /(?:^|\/)index\.html?$/i.test(n));
  if (pages.length === 1) return pages[0];
  const docs = list.filter(n => /\.(?:html?|pptx|docx|xlsx|pdf|mp4|png|jpe?g|svg)$/i.test(n));
  return docs.length === 1 ? docs[0] : list.length === 1 ? list[0] : "";
}

function openFile(root, name, { run = spawnSync, platform = process.platform, io = fs } = {}) {
  const base = io.realpathSync(root);
  const abs = io.realpathSync(path.resolve(base, name));
  const rel = path.relative(base, abs);
  if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) throw new Error("只能打开当前工作目录内的文件");
  if (!io.statSync(abs).isFile()) throw new Error("目标不是文件");
  const plan = openerFor(platform, abs);
  let result = run(plan.cmd, plan.args, { encoding: "utf8", timeout: 15000, windowsHide: false });
  // An HTML file may have no file association even though a browser is installed.
  if ((result.error || result.status) && platform === "darwin" && /\.html?$/i.test(abs)) {
    for (const browser of ["/Applications/Safari.app", "/System/Applications/Safari.app", "/Applications/Google Chrome.app", "/Applications/Microsoft Edge.app", "/Applications/Firefox.app"]) {
      if (!io.existsSync(browser)) continue;
      result = run("open", ["-a", browser, abs], { encoding: "utf8", timeout: 15000, windowsHide: false });
      if (!result.error && result.status === 0) break;
    }
  }
  return { ok: !result.error && result.status === 0, path: abs, error: result.error ? result.error.message : result.status ? `退出码 ${result.status}` : "" };
}

function promptBlock() {
  return `## 当前入口：终端 CLI
用户正在真实终端中工作，没有成果面板、聊天文件卡片或应用预览窗口。以下约定优先于通用界面交付说明和技能文档中的界面指引。
- 问候和简单问题直接简短回答；执行任务时直接使用工具。不要把内部准备、读技能、选择风格和每次自检逐段复述给用户；必要进度最多一句，最后说明结果、实际文件路径和未完成的部分。
- 交付使用真实相对路径或绝对路径，不生成 artifact: 链接，不重复写同一个文件名，不要求用户去成果面板点击。
- 用户说“打开刚才的网站/文件”时，或明确要求“完成后打开”，终端会调用本机程序处理；不要把打开文件改成截图、搭服务器、部署网站或读取发布技能，也不要在命令沙箱中反复尝试启动浏览器。没有操作系统成功回执，不得声称已经打开。
- 编写文件就直接写入当前任务目录，依赖和浏览器能力以实际工具结果为准；联网查询先实际搜索再回答，无法完成时报告具体失败原因。`;
}

module.exports = { openRequest, openAfterTask, currentFiles, recentTarget, openFile, promptBlock };
