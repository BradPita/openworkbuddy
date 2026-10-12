// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/** 结果推送 — 企业微信群机器人 + 钉钉自定义机器人（支持加签），任务/定时任务完成通知共用。 */

const crypto = require("crypto");

async function pushWecom(imCfg, text) {
  const url = imCfg.wecom_bot_webhook;
  if (!url) return false;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ msgtype: "text", text: { content: text.slice(0, 2000) } }),
    signal: AbortSignal.timeout(15000),
  });
  return true;
}

async function pushDingtalk(imCfg, text) {
  let url = imCfg.dingtalk_webhook;
  if (!url) return false;
  if (imCfg.dingtalk_secret) {
    const ts = Date.now();
    const sign = encodeURIComponent(
      crypto.createHmac("sha256", imCfg.dingtalk_secret).update(`${ts}\n${imCfg.dingtalk_secret}`).digest("base64")
    );
    url += `${url.includes("?") ? "&" : "?"}timestamp=${ts}&sign=${sign}`;
  }
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ msgtype: "text", text: { content: text.slice(0, 2000) } }),
    signal: AbortSignal.timeout(15000),
  });
  return true;
}

/**
 * 能主动推送的长连接通道（扫码连的个人微信）。它们活在 IM 路由里，这里只留个插口：
 * 定时任务、notify_user、自进化都只认 pushBots，插上以后一处不用改就都推得到。
 * 以前只认企业微信和钉钉两个群机器人——助理模式连好了微信，定时任务照样一句都推不到。
 */
const extra = new Map(); // name -> { ready: () => boolean, push: async (text) => void }

function registerPusher(name, pusher) {
  if (pusher) extra.set(name, pusher);
  else extra.delete(name);
}

/** 有没有哪条通道推得出去：群机器人地址填了，或者插上的通道说自己好了 */
function anyPushReady(config) {
  const im = (config || {}).im || {};
  if (im.wecom_bot_webhook || im.dingtalk_webhook) return true;
  for (const p of extra.values()) { try { if (p.ready()) return true; } catch {} }
  return false;
}

/**
 * 推送到所有已配置的通道；单通道失败不影响其他通道，返回成功的通道名列表。
 * skip：不推的通道名。从微信里发来的任务，回复已经在微信里了，别再推一遍
 */
async function pushBots(config, text, { skip = [] } = {}) {
  const imCfg = (config || {}).im || {};
  const sent = [];
  for (const [name, fn] of [["wecom", pushWecom], ["dingtalk", pushDingtalk]]) {
    try {
      if (await fn(imCfg, text)) sent.push(name);
    } catch (e) {
      console.warn(`[${name}] 推送失败:`, e.message);
    }
  }
  for (const [name, p] of extra) {
    if (skip.includes(name)) continue;
    try {
      if (!p.ready()) continue;
      await p.push(text);
      sent.push(name);
    } catch (e) {
      console.warn(`[${name}] 推送失败:`, e.message);
    }
  }
  return sent;
}

module.exports = { pushBots, pushWecom, pushDingtalk, registerPusher, anyPushReady };
