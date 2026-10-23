// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 OpenWorkBuddy Contributors
"use strict";
const HOME = require("./lib/own-home")("mcp-policy");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const assert = require("assert/strict");
const { mod } = require("./lib/mod");
const policy = require(mod("mcp-policy"));
const importer = require(mod("mcp-import"));
const bridge = require(mod("connector-policy"));
const security = require(mod("security"));
let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log("✓ " + name); }

(async () => {
  await check("连接器独立读取共享工作区，并发素材与默认缓存互不串用", () => {
    require("child_process").execFileSync(process.execPath, ["-e", `
      const assert = require("assert/strict"), path = require("path"), fs = require("fs");
      const workspace = require(${JSON.stringify(mod("workspace"))});
      const mcp = require(${JSON.stringify(mod("mcp"))});
      const toolsPath = ${JSON.stringify(mod("tools"))};
      const root = ${JSON.stringify(path.join(HOME, "workspace-context"))};
      const initial = workspace.setWorkspaceDir(path.join(root, "default"));
      assert(!require.cache[toolsPath], "连接器加载了整个工具执行器");
      const manager = new mcp.McpManager();
      assert.equal(manager._cacheFile(), path.join(initial, mcp.TOOLS_CACHE_REL));
      (async () => {
        await Promise.all(Array.from({ length: 12 }, (_, i) => workspace.withWorkspace(path.join(root, "task-" + i), async () => {
          const own = workspace.getWorkspaceDir();
          await new Promise(resolve => setTimeout(resolve, 1 + i % 3));
          assert.equal(workspace.getWorkspaceDir(), own);
          assert.equal(workspace.getDefaultWorkspaceDir(), initial);
          assert.equal(manager._cacheFile(), path.join(initial, mcp.TOOLS_CACHE_REL));
          const out = mcp.renderContent([{ type: "audio", mimeType: "audio/wav", data: Buffer.from("fixture-" + i).toString("base64") }]);
          assert.equal(out.media.length, 1);
          assert.equal(out.media[0].file, path.join(own, out.media[0].path));
          assert.equal(fs.readFileSync(out.media[0].file, "utf8"), "fixture-" + i);
          await assert.rejects(workspace.withWorkspace(path.join(own, "nested"), async () => { throw new Error("fixture"); }));
          assert.equal(workspace.getWorkspaceDir(), own);
          workspace.withWorkspace("", () => assert.equal(workspace.getWorkspaceDir(), own));
          workspace.withWorkspace(path.join(own, "scope"), () => {
            workspace.enterWorkspace(path.join(own, "entered"));
            assert.equal(workspace.getWorkspaceDir(), path.join(own, "entered"));
          });
          assert.equal(workspace.getWorkspaceDir(), own);
        })));
        assert.equal(workspace.getWorkspaceDir(), initial);
        assert(!require.cache[toolsPath], "素材落盘又加载了整个工具执行器");
        const tools = require(toolsPath);
        for (const key of ["getWorkspaceDir", "getDefaultWorkspaceDir", "setWorkspaceDir", "withWorkspace", "enterWorkspace"])
          assert.equal(tools[key], workspace[key], "工具没有复用共享上下文：" + key);
        await tools.withWorkspace(path.join(root, "via-tools"), async () => {
          await Promise.resolve();
          assert.equal(workspace.getWorkspaceDir(), tools.getWorkspaceDir());
        });
        assert.equal(workspace.getWorkspaceDir(), initial);
      })().catch(e => { console.error(e); process.exitCode = 1; });
    `], { timeout: 20000, stdio: "pipe", env: process.env });
  });
  const p = { fixture: { default: "allow", tools: { read: "allow", write: "ask", remove: "deny" } } };
  await check("工具权限优先于连接器默认；只读档仍先问", () => {
    assert.equal(policy.effective(p, "fixture", "write", "bypass"), "ask");
    assert.equal(policy.effective(p, "fixture", "remove", "auto"), "deny");
    assert.equal(policy.effective(p, "fixture", "read", "plan"), "ask");
    assert.equal(policy.offered(p, "fixture", "remove"), false);
    assert.equal(policy.effective({}, "fixture", "read", "ask"), "ask");
    assert.equal(policy.effective({}, "fixture", "read", "auto"), "allow");
  });
  await check("清理不合法策略和原型键；清空字段恢复继承", () => {
    assert.deepEqual(policy.clean(JSON.parse('{"__proto__":{"default":"allow"},"fixture":{"default":"bad","tools":{"constructor":"allow","read":"deny"}}}')), { fixture: { tools: { read: "deny" } } });
    assert.equal(policy.explicitOf(policy.withServer(p, "fixture", { tools: { write: "" } }), "fixture", "write"), "allow");
    assert.throws(() => policy.withServer(p, "fixture", { default: "unknown" }));
    assert.deepEqual(policy.prune(p, []), {});
  });
  await check("审批参数遮住令牌，保留工作说明", () => {
    const secret = crypto.randomBytes(20).toString("hex");
    const view = policy.previewArgs({ access_token: secret, nested: { password: secret }, description: "Write a report" });
    assert.ok(!view.includes(secret)); assert.ok(view.includes("Write a report"));
  });
  await check("拒绝的工具执行前拦截；先问的归属与批准结果传递", async () => {
    const ask = security.requestApproval, audit = security.audit;
    const seen = []; security.audit = () => {};
    security.requestApproval = async (kind, text, options) => { seen.push(options); return true; };
    try {
      assert.equal((await policy.gate({ pol: p, sec: { permission_mode: "auto" }, server: "fixture", tool: "remove", input: {} })).isError, true);
      assert.equal(seen.length, 0);
      assert.equal(await policy.gate({ pol: p, sec: { permission_mode: "auto" }, server: "fixture", tool: "write", input: {}, owner: "fixture-user", sessionId: "fixture-session" }), null);
      assert.equal(seen[0].owner, "fixture-user"); assert.equal(seen[0].sessionId, "fixture-session");
      security.requestApproval = async () => false;
      assert.equal((await policy.gate({ pol: p, sec: { permission_mode: "auto" }, server: "fixture", tool: "write", input: {} })).isError, true);
    } finally { security.requestApproval = ask; security.audit = audit; }
  });
  await check("不能审批的引擎不执行先问工具；能够审批时保留规则", () => {
    const servers = [{ cli: "fixture", name: "fixture" }];
    const unattended = bridge.plan(servers, { policy: p, engine: "codex", mode: "auto" });
    assert.deepEqual(unattended.disabledTools.fixture.sort(), ["remove", "write"]);
    const interactive = bridge.plan(servers, { policy: p, engine: "claude-code", askHuman: true, mode: "auto" });
    assert.ok(interactive.ask.includes("mcp__fixture__write")); assert.ok(interactive.deny.includes("mcp__fixture__remove"));
    const bypass = bridge.plan(servers, { policy: p, engine: "claude-code", askHuman: true, bypass: true, mode: "auto" });
    assert.ok(bypass.deny.includes("mcp__fixture__write"));
    assert.equal(bridge.ruleFor({ fixture: { server: "fixture", default: "deny", tools: { read: "allow" } } }, "mcp__fixture__read").policy, "allow");
  });
  await check("本机导入只返回键名和脱敏清单，服务端选择时取原配置", () => {
    const secret = "fixture-" + crypto.randomBytes(16).toString("hex");
    const directory = path.join(HOME, ".cursor"); fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "mcp.json"), JSON.stringify({ login: { token: secret }, mcpServers: { fixture: { command: "node", args: ["tool.js", "--token", secret], env: { TEST_TOKEN: secret } } } }));
    const env = { OWB_IMPORT_HOME: HOME };
    const listed = importer.list({ env, platform: "darwin" });
    assert.ok(!JSON.stringify(listed).includes(secret));
    const row = listed.items.find((x) => x.source === "cursor"); assert.deepEqual(row.env_keys, ["TEST_TOKEN"]);
    const picked = importer.pick("cursor", "fixture", { env, platform: "darwin" }); assert.equal(picked.env.TEST_TOKEN, secret);
    assert.equal(picked.login, undefined); assert.throws(() => importer.pick("other", "fixture", { env }));
    fs.writeFileSync(path.join(directory, "mcp.json"), '{"private": "' + secret + '"');
    assert.ok(!JSON.stringify(importer.list({ env })).includes(secret));
  });
  await check("TOML 的远程与环境字段可导入；异常结构不污染原型", () => {
    const parsed = importer.parseToml('[mcp_servers.fixture]\ncommand="node"\nargs=["tool.js", "a b"]\n[mcp_servers.fixture.env]\nTEST_VALUE="value"\n');
    assert.deepEqual(parsed.mcp_servers.fixture.args, ["tool.js", "a b"]);
    assert.equal(importer.entryOf("fixture", parsed.mcp_servers.fixture, "toml").env.TEST_VALUE, "value");
    assert.throws(() => importer.parseToml('[__proto__]\nx="value"'));
    assert.equal(importer.entryOf("bad", { command: [] }, "json"), null);
  });
  console.log(`MCP policy/import: ${passed} checks passed`);
})().catch((e) => { console.error(e.stack || e); process.exitCode = 1; });
