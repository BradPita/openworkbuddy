// SPDX-License-Identifier: MIT
// Copyright (c) 2026 OpenWorkBuddy Contributors
"use strict";
/** Reuse only a fresh, completed main push of the exact release commit. */
function verifiedMainCi(runs, sha, now = Date.now()) {
  if (!/^[0-9a-f]{40}$/.test(sha || "")) return null;
  return (Array.isArray(runs) ? runs : []).find(r => {
    const at = Date.parse(r.updated_at || "");
    return Number.isSafeInteger(r.id) && r.id > 0 && r.head_sha === sha && r.head_branch === "main" && r.event === "push"
      && r.path === ".github/workflows/test.yml" && r.status === "completed" && r.conclusion === "success"
      && Number.isFinite(at) && now >= at && now - at < 24 * 60 * 60 * 1000;
  }) || null;
}
if (require.main === module) {
  try {
    const repo = process.env.GITHUB_REPOSITORY || "", sha = process.env.GITHUB_SHA || "";
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^[0-9a-f]{40}$/.test(sha)) throw new Error("Missing release context");
    const text = require("child_process").execFileSync("gh", ["api", "repos/" + repo + "/actions/workflows/test.yml/runs?head_sha=" + sha + "&event=push&status=success&per_page=50"], { encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "ignore"] });
    const found = verifiedMainCi(JSON.parse(text).workflow_runs, sha);
    if (found) process.stdout.write(String(found.id) + "\n");
  } catch { /* No trusted result: the workflow runs npm ci and npm test in full. */ }
}
module.exports = { verifiedMainCi };
