// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 OpenWorkBuddy Contributors · 商业使用需授权：COMMERCIAL-LICENSE.md
"use strict";
/**
 * 导入本机终端里的 Claude Code / Codex 会话：
 *   GET  /api/import/local                    每个来源还有几条没导（只 readdir + stat，带缓存）
 *   GET  /api/import/local/list?source=&offset=&limit=   一页清单：标题、时间、文件夹名
 *   POST /api/import/local {source, ids | all}           开始导（后台跑），202 回进度单；正在导就 409
 *   GET  /api/import/local/job                当前这一单导到哪儿了
 *
 * 谁能用：只有这台机器的主人——个人桌面版，或者平台管理员。
 * ~/.claude、~/.codex 是跑服务器的那个系统账号的东西，组织成员一律 403，连有几条都不告诉。
 * 这道闸在这儿自己判，同时 /api/import/ 也进了 admin.platformGuard 的读写两张表，两道都得过。
 *
 * 找、数、读、写都在 src/domains/import/session-import.js，这里只管认人和收发。
 */
const express = require("express");

/**
 * @param deps.isOwner  (req) => 是不是这台机器的主人
 * @param deps.importer createSessionImporter() 的返回值
 */
function createSessionImportRouter({ isOwner, importer, enabled = false }) {
  const router = express.Router();

  router.use("/api/import/local", (req, res, next) => {
    if (!enabled) return res.status(404).json({ error: "会话导入暂未开放", disabled: true });
    if (!isOwner(req)) return res.status(403).json({ error: "只有这台机器的主人能导入本机会话", platform_only: true });
    next();
  });

  const fail = (res, e) => {
    const status = (e && e.status) || 500;
    if (status >= 500) console.warn(`[导入] ${(e && e.message) || e}`);
    res.status(status).json({ error: status >= 500 ? "本机会话没读出来，稍后再试" : e.message });
  };

  router.get("/api/import/local", async (req, res) => {
    try { res.json({ sources: await importer.count() }); } catch (e) { fail(res, e); }
  });

  router.get("/api/import/local/list", async (req, res) => {
    try {
      res.json(await importer.list(String(req.query.source || ""), { offset: req.query.offset, limit: req.query.limit }));
    } catch (e) { fail(res, e); }
  });

  router.post("/api/import/local", async (req, res) => {
    const b = req.body || {};
    try {
      const r = await importer.start(String(b.source || ""), {
        ids: Array.isArray(b.ids) ? b.ids.slice(0, 2000) : [],
        all: b.all === true,
        owner: req.user ? req.user.username : "",
      });
      if (r.busy) return res.status(409).json({ error: "上一批还在导，等它导完再来", busy: true, job: r.job });
      res.status(202).json({ job: r.job });
    } catch (e) { fail(res, e); }
  });

  router.get("/api/import/local/job", (req, res) => {
    res.json({ job: importer.job() });
  });

  return router;
}

module.exports = { createSessionImportRouter };
