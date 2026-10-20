// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 OpenWorkBuddy Contributors
"use strict";
const HOME = require("./lib/own-home")("mcp-oauth");
const fs = require("fs"), path = require("path"), http = require("http"), crypto = require("crypto"), assert = require("assert/strict");
const { mod } = require("./lib/mod");
const oauth = require(mod("mcp-oauth"));
const { HttpTransport } = require(mod("mcp"));
let count = 0;
const check = async (name, fn) => { await fn(); count++; console.log("✓ " + name); };
(async () => {
 let base = "", issuer = "", mode = "ok", pkce = true, issued = 0, refreshes = 0, issuedToken = "", seen = [], deferred;
 const secret = "fixture-" + crypto.randomBytes(18).toString("hex");
 const server = http.createServer((req, res) => {
  let body = ""; req.on("data", d => body += d); req.on("end", () => {
   const j = (code, value, headers = {}) => { res.writeHead(code, { "Content-Type": "application/json", ...headers }); res.end(JSON.stringify(value)); };
   const route = req.url.split("?")[0]; seen.push({ path: route, headers: { ...req.headers }, body });
   if (route === "/mcp" && req.method === "GET") return j(401, { error: "unauthorized" }, { "WWW-Authenticate": 'Bearer resource_metadata="' + base + '/resource", scope="mcp.read"' });
   if (route === "/resource") return j(200, { resource: base + "/mcp", authorization_servers: [issuer], scopes_supported: ["mcp.read", "mcp.write"] });
   if (route === "/.well-known/oauth-authorization-server/tenant") return j(200, { issuer: mode === "issuer" ? issuer + "/" : issuer, authorization_endpoint: base + "/authorize", token_endpoint: base + "/token", registration_endpoint: base + "/register", code_challenge_methods_supported: pkce ? ["S256"] : [], authorization_response_iss_parameter_supported: true });
   if (route === "/register") return j(201, { client_id: "fixture-client", token_endpoint_auth_method: "none" });
   if (route === "/token") {
    const form = new URLSearchParams(body);
    if (mode === "echo") return j(400, { error: secret, code: form.get("code"), token: form.get("refresh_token") });
    const done = () => { if (form.get("grant_type") === "refresh_token") refreshes++; issued++; issuedToken = secret + "." + issued; j(200, { access_token: issuedToken, refresh_token: "refresh." + issued, token_type: "Bearer", expires_in: 60 }); };
    if (mode === "delay") { deferred = done; return; } done(); return;
   }
   if (route === "/redirect") { res.writeHead(302, { Location: base + "/token" }); res.end(); return; }
   if (route === "/big") { res.writeHead(200, { "Content-Type": "application/json" }); res.end('"' + "x".repeat(1024 * 1024 + 1) + '"'); return; }
   if (route === "/mcp" && req.method === "POST") {
    if (req.headers.authorization !== "Bearer " + issuedToken) return j(401, { echo: req.headers.authorization });
    const rpc = JSON.parse(body || "{}"); return j(200, { jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: "result " + issuedToken }] } });
   }
   j(404, {});
  });
 });
 await new Promise(r => server.listen(0, "127.0.0.1", r)); base = "http://127.0.0.1:" + server.address().port; issuer = base + "/tenant";
 const file = path.join(HOME, "oauth.json"), cfg = { name: "fixture", url: base + "/mcp" };
 const security = () => ({ gateway: true, url_allow_local: ["127.0.0.1:*"] }); let clock = Date.now();
 const manager = oauth.createOAuthManager({ file, security, now: () => clock });
 const redirect = "http://127.0.0.1:3800/api/mcp/oauth/callback";
 try {
  await check("发现路径与挑战头符合规范；不接受非 HTTPS 远程地址", () => {
   assert.deepEqual(oauth.resourceUrls("https://example.invalid/path/mcp"), ["https://example.invalid/.well-known/oauth-protected-resource/path/mcp", "https://example.invalid/.well-known/oauth-protected-resource"]);
   assert.deepEqual(oauth.issuerUrls("https://auth.invalid/tenant"), ["https://auth.invalid/.well-known/oauth-authorization-server/tenant", "https://auth.invalid/.well-known/openid-configuration/tenant", "https://auth.invalid/tenant/.well-known/openid-configuration"]);
   assert.equal(oauth.challenge('Basic realm="x", Bearer resource_metadata="https://example.invalid/meta", scope="read write"').scope, "read write");
   assert.throws(() => oauth.safeUrl("http://example.invalid")); assert.throws(() => oauth.safeUrl("https://user:secret@example.invalid"));
  });
  await check("安全规则先拦内网与重定向；元数据大小受限", async () => {
   await assert.rejects(oauth.checkedFetch(base + "/resource", {}, {}), /安全规则/);
   const before = seen.length; await assert.rejects(oauth.checkedFetch(base + "/redirect", {}, security()), /重定向/); assert.equal(seen.length, before + 1);
   await assert.rejects(oauth.jsonOf(await oauth.checkedFetch(base + "/big", {}, security())), /响应过大/);
  });
  await check("拒绝不匹配的 issuer 和没有 S256 的服务", async () => {
   mode = "issuer"; await assert.rejects(manager.begin(cfg, "owner", redirect), /标识不一致/); mode = "ok";
   pkce = false; await assert.rejects(manager.begin(cfg, "owner", redirect), /PKCE S256/); pkce = true;
  });
  let flow;
  await check("自动注册、强随机 state 与 PKCE；只申请挑战指定的范围", async () => {
   flow = await manager.begin(cfg, "owner", redirect); const url = new URL(flow.authorization_url);
   assert.match(flow.flow_id, /^[\w-]{43}$/); assert.equal(url.searchParams.get("resource"), cfg.url); assert.equal(url.searchParams.get("code_challenge_method"), "S256"); assert.equal(url.searchParams.get("scope"), "mcp.read");
   const registration = JSON.parse(seen.find(x => x.path === "/register").body); assert.deepEqual(registration.redirect_uris, [redirect]); assert.equal(registration.token_endpoint_auth_method, "none");
   assert.equal(JSON.stringify(flow).includes(secret), false); assert.equal(manager.status(cfg).authorized, false);
  });
  await check("外部浏览器只寄存授权码，只有发起账号能兑换；回调不可重放", async () => {
   assert.deepEqual(await manager.finish(flow.flow_id, "owner"), { ready: false });
   assert.throws(() => manager.receive({ state: flow.flow_id, code: "code", iss: issuer + "/" }), /不一致/);
   manager.receive({ state: flow.flow_id, code: "fixture-code", iss: issuer }); assert.throws(() => manager.receive({ state: flow.flow_id, code: "other", iss: issuer }), /已收到/);
   assert.equal(issued, 0); await assert.rejects(manager.finish(flow.flow_id, "other"), /不属于/);
   const result = await manager.finish(flow.flow_id, "owner", c => c.url === cfg.url); assert.equal(result.ready, true); assert.equal(issued, 1); assert.equal(manager.scrub(issuedToken), "***");
   const form = new URLSearchParams(seen.filter(x => x.path === "/token").at(-1).body); assert.equal(form.get("code"), "fixture-code"); assert.equal(form.get("resource"), cfg.url);
   assert.equal(crypto.createHash("sha256").update(form.get("code_verifier")).digest("base64url"), new URL(flow.authorization_url).searchParams.get("code_challenge"));
   await assert.rejects(manager.finish(flow.flow_id, "owner"), /失效/);
   if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
   assert.equal(fs.existsSync(file + ".bak"), false);
  });
  await check("重启后读取凭据；改变目标地址不会携带旧令牌", async () => {
   const restarted = oauth.createOAuthManager({ file, security, now: () => clock }); assert.equal(await restarted.token(cfg), issuedToken);
   assert.equal(restarted.status({ ...cfg, url: base + "/other" }).authorized, false); assert.equal(await restarted.token({ ...cfg, url: base + "/other" }), null);
  });
  await check("过期刷新合并并发请求，保留服务端轮换后的 refresh token", async () => {
   clock += 40000; const before = refreshes; const tokens = await Promise.all([manager.token(cfg), manager.token(cfg), manager.token(cfg)]); assert.equal(refreshes, before + 1); assert.equal(new Set(tokens).size, 1);
   const rows = Object.values(JSON.parse(fs.readFileSync(file)).records); assert.equal(rows[0].refresh_token, "refresh." + issued);
  });
  await check("HTTP 传输按授权注入，成功与失败响应都不回显访问令牌", async () => {
   const transport = new HttpTransport("fixture", { url: cfg.url, oauthToken: options => manager.token(cfg, options), oauthFetch: manager.fetch });
   const result = await transport.request("tools/call", { name: "fixture" }, 5000); assert.equal(JSON.stringify(result).includes(issuedToken), false); assert.ok(JSON.stringify(result).includes("***"));
   const previous = issuedToken; issuedToken = "upstream-rotated";
   const result2 = await transport.request("tools/call", {}, 5000); assert.equal(JSON.stringify(result2).includes(previous), false); assert.ok(refreshes >= 2);
  });
  await check("超时、主动取消与连接器改变阻止授权兑换", async () => {
   const expired = await manager.begin(cfg, "owner", redirect); clock += 600001; assert.throws(() => manager.receive({ state: expired.flow_id, code: "expired", iss: issuer }), /失效/);
   const cancelled = await manager.begin(cfg, "owner", redirect); manager.cancel(cancelled.flow_id, "other"); assert.deepEqual(await manager.finish(cancelled.flow_id, "owner"), { ready: false }); manager.cancel(cancelled.flow_id, "owner"); await assert.rejects(manager.finish(cancelled.flow_id, "owner"), /失效/);
   const changed = await manager.begin(cfg, "owner", redirect); manager.receive({ state: changed.flow_id, code: "code", iss: issuer }); const before = issued; await assert.rejects(manager.finish(changed.flow_id, "owner", () => false), /已改变/); assert.equal(issued, before);
  });
  await check("服务端错误体不会进入日志或界面错误文本", async () => {
   const failed = await manager.begin(cfg, "owner", redirect); mode = "echo"; await assert.rejects(manager.complete({ state: failed.flow_id, code: secret, iss: issuer }, "owner"), (e) => !e.message.includes(secret) && /HTTP 400/.test(e.message)); mode = "ok";
  });
  await check("刷新途中移除授权，响应不能把凭据恢复回来", async () => {
   mode = "delay"; const refresh = manager.token(cfg, { force: true });
   for (let i = 0; !deferred && i < 100; i++) await new Promise(r => setTimeout(r, 5)); assert.ok(deferred); manager.revoke(cfg); deferred(); deferred = null; await assert.rejects(refresh, /撤回/); assert.equal(manager.status(cfg).authorized, false); mode = "ok";
  });
  await check("兑换途中移除授权，旧响应同样不能复活凭据", async () => {
   const cancelled = await manager.begin(cfg, "owner", redirect); mode = "delay"; const finish = manager.complete({ state: cancelled.flow_id, code: "code", iss: issuer }, "owner");
   for (let i = 0; !deferred && i < 100; i++) await new Promise(r => setTimeout(r, 5)); assert.ok(deferred); manager.revoke(cfg); deferred(); deferred = null; await assert.rejects(finish, /撤回/); assert.equal(manager.status(cfg).authorized, false); mode = "ok";
  });
  console.log(`MCP OAuth: ${count} checks passed`);
 } finally { await new Promise(r => server.close(r)); }
})().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
