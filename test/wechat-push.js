// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 开发者猫叔 (DeveloperCatUncle) · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 定时任务 / notify_user 推到扫码连的个人微信。
 *
 * 2026-10-12 用户：助理模式连好了微信，「每天 7 点叫我起床」跑完一句都没推到——
 * notify.pushBots 只认企业微信、钉钉两个群机器人，agent 自己满世界找发消息的工具，找不到就说发不出去。
 * 全程假 fetch，不连微信。
 */
const { mod } = require("./lib/mod");

let fails = 0;
const ok = (name, cond, extra) => {
  console.log(`  ${cond ? "✓" : "✗"} ${name}${cond || extra === undefined ? "" : "  → " + extra}`);
  if (!cond) fails++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const realFetch = global.fetch;
  const sent = [];
  let polls = 0;
  let pollHook = null; // 第二段起接管 getupdates
  const typing = [];
  global.fetch = async (url, init) => {
    const body = JSON.parse(init.body || "{}");
    const ep = String(url).split("/ilink/bot/")[1];
    const json = (o) => ({ text: async () => JSON.stringify(o) });
    if (ep === "getupdates" && pollHook) return pollHook(json);
    if (ep === "getconfig") { typing.push("ticket"); return json({ ret: 0, typing_ticket: "tk-" + body.ilink_user_id }); }
    if (ep === "sendtyping") { typing.push(`${body.typing_ticket}:${body.status}`); return json({ ret: 0 }); }
    if (ep === "getupdates") {
      polls++;
      if (polls === 1) {
        return json({ ret: 0, get_updates_buf: "b1", msgs: [{ from_user_id: "u1", context_token: "ct-1", message_id: 1, item_list: [{ type: 1, text_item: { text: "在吗" } }] }] });
      }
      await sleep(30);
      return json({ ret: 0, msgs: [] });
    }
    if (ep === "sendmessage") { sent.push(body.msg); return json({ ret: 0 }); }
    return json({ ret: 0 });
  };

  try {
    const { createIlinkConnection } = require(mod("im-ilink"));
    const cfg = { bot_token: "t", ilink_bot_id: "b", base_url: "http://ilink.invalid" };
    const saved = [];
    const quiet = { log() {}, warn() {}, error() {} };
    const mk = () => createIlinkConnection({ getConfig: () => cfg, onMessage: () => {}, onContext: (t) => saved.push(t), log: quiet });

    // ① 没人发过话：推不了，原话说清
    const a = mk();
    const e0 = await a.pushAll("早上好").catch((e) => e);
    ok("没人发过话：pushAll 报错并说清要先发一句", e0 instanceof Error && /先在微信里给它发一句/.test(e0.message), e0 && e0.message);

    // ② 对方发过一句：凭据落盘，推得出去
    await a.start();
    for (let i = 0; i < 100 && !saved.length; i++) await sleep(10);
    ok("对方发过话：回话凭据交给调用方落盘", saved.length === 1 && saved[0].u1 === "ct-1", JSON.stringify(saved));
    const n = await a.pushAll("起床啦");
    ok("pushAll 发给发过话的人，带上那条凭据", n === 1 && sent.length === 1 && sent[0].to_user_id === "u1" && sent[0].context_token === "ct-1", JSON.stringify(sent));
    await a.stop();

    // ③ 重启：从配置里读回凭据，不用对方再说一句
    cfg.context_tokens = saved[0];
    polls = 99; // 不再收到新消息
    const b = mk();
    await b.start();
    ok("★重启后读回凭据：状态里算作能回话★", b.status().repliable === 1, JSON.stringify(b.status()));
    await b.pushAll("22:20 该准备睡觉了");
    ok("★重启后照样推得到★", sent.length === 2 && sent[1].context_token === "ct-1");

    // ④ 「对方正在输入」：亮一次、收一次，凭据没换就不重复要票
    const stopT = b.startTyping("u1");
    await sleep(20);
    await stopT();
    await stopT(); // 多收一次不该再发
    const stopT2 = b.startTyping("u1");
    await sleep(20);
    await stopT2();
    ok("★正在输入：亮(1)、收(2)，票只要一次★", JSON.stringify(typing) === '["ticket","tk-u1:1","tk-u1:2","tk-u1:1","tk-u1:2"]', JSON.stringify(typing));
    typing.length = 0;
    const stopNobody = b.startTyping("没发过话的人");
    await sleep(20); await stopNobody();
    ok("没发过话的人：不要票、不发输入状态", typing.length === 0, JSON.stringify(typing));
    await b.stop();

    // ⑤ 跑任务时照样收消息：onMessage 一直不返回，下一条也得进来
    {
      let n = 0;
      pollHook = async (json) => {
        n++;
        if (n <= 2) return json({ ret: 0, msgs: [{ from_user_id: "u2", context_token: "ct-2", message_id: 100 + n, item_list: [{ type: 1, text_item: { text: n === 1 ? "做个长任务" : "停" } }] }] });
        await sleep(30);
        return json({ ret: 0, msgs: [] });
      };
      const got = [];
      const c = createIlinkConnection({ getConfig: () => cfg, onMessage: (m) => { got.push(m.text); return new Promise(() => {}); }, log: quiet });
      await c.start();
      for (let i = 0; i < 100 && got.length < 2; i++) await sleep(10);
      ok("★任务没跑完，下一条（比如「停」）也收得到，顺序不乱★", JSON.stringify(got) === '["做个长任务","停"]', JSON.stringify(got));
      await c.stop();
    }

    // ⑥ 网络抖一下（fetch failed 秒断）：1 秒后就重连，不再按 3 秒起跳
    {
      let n = 0;
      const at = [];
      pollHook = async (json) => {
        n++; at.push(Date.now());
        if (n === 1) throw new TypeError("fetch failed");
        await sleep(30);
        return json({ ret: 0, msgs: [] });
      };
      const c = createIlinkConnection({ getConfig: () => cfg, onMessage: () => {}, log: quiet });
      await c.start();
      for (let i = 0; i < 300 && n < 2; i++) await sleep(10);
      const gap = at[1] - at[0];
      ok("★断网秒断：约 1 秒后重连★", n >= 2 && gap >= 900 && gap < 2000, `gap=${gap}`);
      for (let i = 0; i < 50 && c.status().state !== "connected"; i++) await sleep(10);
      ok("重连上了状态回到已连接", c.status().state === "connected", c.status().state);
      await c.stop();
      pollHook = null;
    }

    // ⑦ notify：插上的通道进 pushBots，skip 跳过，没好的不推，挂了不拖累别人
    const notify = require(mod("notify"));
    const got = [];
    notify.registerPusher("wechat_ilink", { ready: () => true, push: async (t) => { got.push(t); } });
    notify.registerPusher("dead", { ready: () => true, push: async () => { throw new Error("断了"); } });
    notify.registerPusher("off", { ready: () => false, push: async () => { got.push("不该推"); } });
    const realWarn = console.warn; console.warn = () => {};
    let r;
    try { r = await notify.pushBots({}, "定时任务跑完了"); } finally { console.warn = realWarn; }
    ok("★pushBots 推到微信★，挂了的不算，没好的不碰", JSON.stringify(r) === '["wechat_ilink"]' && got.length === 1, JSON.stringify(r) + JSON.stringify(got));
    const r2 = await notify.pushBots({}, "微信里来的任务", { skip: ["wechat_ilink", "dead"] });
    ok("从微信来的任务：skip 掉微信，不重复推", r2.length === 0 && got.length === 1, JSON.stringify(r2));
    ok("anyPushReady：只连了微信也算有通道（notify_user 才会出现）", notify.anyPushReady({}) === true);
    notify.registerPusher("wechat_ilink", null); notify.registerPusher("dead", null); notify.registerPusher("off", null);
    ok("反向对照：什么都没配就是没通道", notify.anyPushReady({}) === false);
  } finally {
    global.fetch = realFetch;
  }

  console.log(fails ? `❌ 微信推送 ${fails} 条没过` : "✅ 定时任务和 notify_user 推得到连好的个人微信，重启不丢，从微信来的不重推");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("❌", e); process.exit(1); });
