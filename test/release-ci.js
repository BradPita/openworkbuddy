// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 OpenWorkBuddy Contributors
"use strict";
const assert = require("assert/strict"), fs = require("fs"), path = require("path");
const { verifiedMainCi } = require("../scripts/release-ci");
try {
  const sha = "a".repeat(40), now = Date.now();
  const good = { id: 123, head_sha: sha, head_branch: "main", event: "push", path: ".github/workflows/test.yml", status: "completed", conclusion: "success", updated_at: new Date(now - 60000).toISOString() };
  assert.equal(verifiedMainCi([good], sha, now), good);
  for (const patch of [{ head_sha: "b".repeat(40) }, { head_branch: "topic" }, { event: "pull_request" }, { event: "workflow_dispatch" }, { status: "in_progress" }, { conclusion: "failure" }, { path: ".github/workflows/other.yml" }, { updated_at: new Date(now - 86400001).toISOString() }, { updated_at: new Date(now + 60000).toISOString() }, { updated_at: "invalid" }, { id: "123" }]) assert.equal(verifiedMainCi([{ ...good, ...patch }], sha, now), null);
  assert.equal(verifiedMainCi([], sha, now), null); assert.equal(verifiedMainCi([good], "main", now), null);
  const yaml = fs.readFileSync(path.join(__dirname, "../.github/workflows/release.yml"), "utf8");
  assert.ok(yaml.includes("actions: read") && yaml.includes("node scripts/release-ci.js"));
  assert.equal((yaml.match(/if: steps\.ci\.outputs\.passed != 'true'/g) || []).length, 2);
  assert.ok(yaml.includes("- run: npm ci") && yaml.includes("- run: npm test") && yaml.includes("needs: test"));
  const testYaml = fs.readFileSync(path.join(__dirname, "../.github/workflows/test.yml"), "utf8");
  const preflight = testYaml.indexOf("run: node test/lib/css-token-gate.js");
  assert.ok(preflight > 0 && preflight < testYaml.indexOf("- run: npm ci"), "UI color preflight runs before dependency installation and the full suite");
  const e2e = fs.readFileSync(path.join(__dirname, "e2e.js"), "utf8");
  assert.ok(e2e.includes('require("./lib/css-token-gate")(path.join(__dirname, ".."))'), "E2E reuses the same color gate");
  require("./lib/css-token-gate")();
  console.log("✓ Release CI: exact SHA, main push, trusted workflow, freshness and full-test fallback");
} catch (e) { console.error(e.stack || e); process.exitCode = 1; }
