// @ts-check
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 成果按对话分文件夹：哪些根下分、文件夹叫什么。
 *
 * 以前只认一个根——默认工作空间（~/OpenWorkBuddy/workspace）。于是装好之后随手建个项目，
 * 哪怕目录一个字没填（落在 ~/OpenWorkBuddy/projects/<名>），从那以后所有对话的产出全摊在项目根下，
 * 两条对话各写一份「报告.html」，后写的那份就把先写的盖了。飞书/微信来的所有对话挤一个 IM_对话/，
 * 所有定时任务挤一个 定时任务/，同样不分对话。
 *
 * 现在的口径：**应用自己建的根**一律按对话分——默认工作空间、没填目录时替项目建的 projects/<名>、
 * 没指定目录的租户根 tenants/<id>。用户自己挑的现成文件夹（代码仓库、素材目录）照旧就地读写：
 * 那里的文件本来就在根上，在里面再套一层「任务_xxx」反倒把人要改的东西和产出拆散了。
 *
 * 路径比较先认真实路径、再看大小写：macOS / Windows 的盘默认不分大小写，
 * 选文件夹时拼成 ~/openworkbuddy/workspace 也还是同一个地方，不能因此判成「用户自选」。
 */
const fs = require("fs");
const path = require("path");

const CASE_FOLD = process.platform === "darwin" || process.platform === "win32";

/** 比较用的规范形：已存在的那一截换成真实路径（/tmp 和 /private/tmp 是同一个），不存在的尾巴原样接上 */
function canonDir(p) {
  let cur = path.resolve(String(p || ""));
  const rest = [];
  for (;;) {
    try { cur = fs.realpathSync.native(cur); break; } catch {}
    const up = path.dirname(cur);
    if (up === cur) break;
    rest.unshift(path.basename(cur));
    cur = up;
  }
  const out = path.join(cur, ...rest);
  return CASE_FOLD ? out.toLowerCase() : out;
}

function samePlace(a, b) {
  if (!a || !b) return false;
  return canonDir(a) === canonDir(b);
}

/**
 * 这个根下要不要按对话分成果文件夹。
 * @param {string} dir 当前工作目录
 * @param {{ workspace: string, projects?: string, tenants?: string }} anchors
 *   workspace = 默认工作空间；projects / tenants = 应用替人建目录的那两个父目录（其下一层才算）
 */
function perChatRoot(dir, anchors) {
  if (!dir || !anchors || !anchors.workspace) return false;
  const d = canonDir(dir);
  if (d === canonDir(anchors.workspace)) return true;
  const parent = path.dirname(d);
  return [anchors.projects, anchors.tenants].some((p) => !!p && parent === canonDir(p));
}

// 素材锚点（【图片 1：IMG_8037.JPG】）是发送时自动补进正文的，不是用户写的字
const ANCHOR = /【(?:图片|视频|音频|文本摘录|文件)\s*\d+：([^】]+)】/gu;
const clean = (t) => String(t).replace(/https?:\/\/\S+/g, "").replace(/[^\p{L}\p{N}]+/gu, "").slice(0, 12);

/**
 * 文件夹名里那段标题：最多 12 个字，只留文字和数字。一个字都剩不下时返回空串，由调用方兜底。
 * 【任务类型：X】前缀和素材锚点先洗掉——不洗的话真实数据里出现过「任务_0826_任务类型数据分析及可视化_3」
 * 和「任务_0921_图片1IMG8037JP」，用户真正问的那句一个字都没进名字。
 * 只拖了张图、一个字没写：拿文件名（去掉扩展名）兜底。
 */
function taskSlug(text) {
  const raw = String(text || "");
  const src = raw.replace(/^\s*【任务类型：[^】]*】\s*/, "").replace(ANCHOR, " ");
  const firstName = ((raw.match(/【(?:图片|视频|音频|文本摘录|文件)\s*\d+：([^】]+)】/u) || [])[1] || "").replace(/\.[^.]+$/, "");
  return clean(src) || clean(firstName);
}

/** 「月日」四位，文件夹名用 */
function dayStamp(d = new Date()) {
  return String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0");
}

/**
 * 在 root 下挑一个还没人用的相对目录名：base、base_2、base_3……
 * taken 是「刚分出去、还没写出文件」的那批（两个新对话同时起步不许撞同名）
 * @param {string} root
 * @param {string} base 相对 root 的路径，可以带一层父目录（IM_对话/0930_做个海报）
 * @param {Set<string>} [taken]
 */
function freeDir(root, base, taken) {
  let dir = base;
  for (let i = 2; fs.existsSync(path.join(root, dir)) || (taken && taken.has(dir)); i++) dir = `${base}_${i}`;
  return dir;
}

/**
 * 一趟跑完什么都没产出，就把刚建的空文件夹撤掉（连同变空了的父目录，如 IM_对话/）。
 * 用 rmdirSync 而不是 rm -r：它删不掉非空目录，判断万一有误，最坏也只是删不动。
 * @returns {boolean} 文件夹现在是否已经不在了
 */
function dropIfEmpty(root, rel) {
  if (!root || !rel) return false;
  const full = path.join(root, rel);
  try {
    if (fs.existsSync(full)) {
      if (fs.readdirSync(full).length) return false;
      fs.rmdirSync(full);
    }
  } catch { return false; }
  // 父目录只收到 root 为止，一层都不越过去
  let up = path.dirname(full);
  while (up !== root && up.startsWith(root + path.sep)) {
    try { if (fs.readdirSync(up).length) break; fs.rmdirSync(up); } catch { break; }
    up = path.dirname(up);
  }
  return true;
}

module.exports = { canonDir, samePlace, perChatRoot, taskSlug, dayStamp, freeDir, dropIfEmpty };
