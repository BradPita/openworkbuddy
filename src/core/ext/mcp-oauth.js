// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 OpenWorkBuddy Contributors
"use strict";
const crypto = require("crypto"), http = require("http"), https = require("https"), { Readable } = require("stream");
const store = require("../../platform/store"), guard = require("../safety/net-guard");
const TTL = 10 * 60 * 1000, LIMIT = 1024 * 1024;
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");
const random = () => crypto.randomBytes(32).toString("base64url");
function safeUrl(value, { query = true } = {}) {
  let u; try { u = new URL(value); } catch { throw new Error("OAuth 地址不合法"); }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.username || u.password || u.hash || !query && u.search || u.protocol !== "https:" && !(local && u.protocol === "http:")) throw new Error("OAuth 需要 HTTPS，本机回环地址可使用 HTTP");
  return u;
}
/** DNS-pinned transport. Credentials never follow redirects, including same-origin redirects. */
async function checkedFetch(url, options = {}, security = {}) {
  const u = safeUrl(url), verdict = await guard.checkUrl(security, u.href);
  if (!verdict.allowed) throw new Error("OAuth 地址被安全规则拦截");
  const signal = options.signal || AbortSignal.timeout(15000);
  return new Promise((resolve, reject) => {
    const body = options.body;
    const req = (u.protocol === "https:" ? https : http).request(u, {
      method: options.method || "GET", headers: { Accept: "application/json", "Accept-Encoding": "identity", ...options.headers, ...(body != null ? { "Content-Length": Buffer.byteLength(body) } : {}) },
      lookup: guard._pinnedLookup(verdict.addrs), signal, agent: false,
    }, (res) => {
      const status = res.statusCode || 500;
      if (status >= 300 && status < 400) { res.destroy(); reject(new Error("OAuth 不会跟随重定向，请检查服务地址")); return; }
      const headers = Object.fromEntries(Object.entries(res.headers).filter(([, v]) => v != null).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : String(v)]));
      if ([204, 205, 304].includes(status)) { res.resume(); resolve(new Response(null, { status, headers })); }
      else resolve(new Response(Readable.toWeb(res), { status, headers }));
    }); req.on("error", reject); if (body != null) req.write(body); req.end();
  });
}
async function jsonOf(response) {
  const reader = response.body?.getReader(); if (!reader) throw new Error("OAuth 服务没有返回元数据");
  let size = 0; const chunks = [];
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > LIMIT) throw new Error("OAuth 响应过大"); chunks.push(Buffer.from(value)); }
    if (!response.ok) throw new Error("OAuth 服务拒绝了请求（HTTP " + response.status + "）");
    try { const data = JSON.parse(Buffer.concat(chunks).toString("utf8")); if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error(); return data; }
    catch { throw new Error("OAuth 服务返回的格式不正确"); }
  } finally { try { await reader.cancel(); } catch {} }
}
function challenge(header) {
  const text = String(header || ""), result = {};
  const start = text.search(/(?:^|,)\s*Bearer\s/i); if (start < 0) return result;
  const bearer = text.slice(start).replace(/^(?:,)?\s*Bearer\s+/i, "").split(/,\s*(?=[A-Za-z][A-Za-z0-9_-]*\s+(?![=]))/)[0];
  for (const m of bearer.matchAll(/([A-Za-z_]+)\s*=\s*(?:"((?:\\.|[^"\\])*)"|([^,\s]+))/g)) result[m[1].toLowerCase()] = (m[2] == null ? m[3] : m[2].replace(/\\(.)/g, "$1"));
  return result;
}
function resourceUrls(url) {
  const u = safeUrl(url, { query: false }), suffix = u.pathname === "/" ? "" : u.pathname.replace(/\/$/, "");
  return [...new Set([u.origin + "/.well-known/oauth-protected-resource" + suffix, u.origin + "/.well-known/oauth-protected-resource"])];
}
function issuerUrls(issuer) {
  const u = safeUrl(issuer, { query: false }), suffix = u.pathname === "/" ? "" : u.pathname.replace(/\/$/, "");
  return [...new Set([u.origin + "/.well-known/oauth-authorization-server" + suffix, u.origin + "/.well-known/openid-configuration" + suffix, u.origin + suffix + "/.well-known/openid-configuration"])];
}
function createOAuthManager({ file, security = () => ({}), request = checkedFetch, now = () => Date.now() }) {
  const pending = new Map(), inflight = new Map(), refreshing = new Map(), epochs = new Map();
  const keyOf = (cfg) => digest(String(cfg.name) + "\n" + safeUrl(cfg.url).href);
  const read = () => { const data = store.readJson(file, { version: 1, records: {} }, { strict: true }); if (!data || data.version !== 1 || !data.records || typeof data.records !== "object" || Array.isArray(data.records)) throw new Error("OAuth 凭据记录损坏"); return data; };
  const write = (data) => store.writeJsonAtomic(file, data, { mode: 0o600, backup: false });
  const call = (url, opts = {}) => request(url, opts, security());
  const fetchJson = async (url, opts = {}) => jsonOf(await call(url, opts));
  const prunePending = () => { for (const [s, p] of pending) if (now() >= p.until) pending.delete(s); };
  async function metadata(urls) {
    for (const url of urls) {
      const response = await call(url);
      if (response.status === 404 || response.status === 405) { await response.body?.cancel(); continue; }
      return jsonOf(response);
    }
    throw new Error("服务未提供 OAuth 元数据");
  }
  async function discover(cfg) {
    const resource = safeUrl(cfg.url).href;
    const probe = await call(resource); const auth = challenge(probe.headers.get("www-authenticate")); await probe.body?.cancel();
    const rm = await metadata(auth.resource_metadata ? [safeUrl(auth.resource_metadata).href] : resourceUrls(resource));
    if (safeUrl(rm.resource).href !== resource) throw new Error("OAuth 元数据的资源地址与连接器不一致");
    const issuer = Array.isArray(rm.authorization_servers) && rm.authorization_servers.find((x) => typeof x === "string");
    if (!issuer) throw new Error("服务未提供授权服务器");
    const as = await metadata(issuerUrls(issuer));
    if (as.issuer !== issuer) throw new Error("OAuth 授权服务器标识不一致");
    if (!Array.isArray(as.code_challenge_methods_supported) || !as.code_challenge_methods_supported.includes("S256")) throw new Error("授权服务器不支持 PKCE S256，无法安全授权");
    safeUrl(as.token_endpoint); safeUrl(as.authorization_endpoint);
    if (!(await guard.checkUrl(security(), as.authorization_endpoint)).allowed && request === checkedFetch) throw new Error("OAuth 地址被安全规则拦截");
    return { resource, issuer, as, rm, auth };
  }
  const status = (cfg) => {
    if (!cfg.url) return { available: false, authorized: false };
    try { const record = read().records[keyOf(cfg)]; return { available: true, authorized: !!record?.access_token, expires_at: record?.expires_at || 0 }; }
    catch { return { available: true, authorized: false }; }
  };
  async function begin(cfg, owner, redirectUri, options = {}) {
    const key = keyOf(cfg), generation = (epochs.get(key) || 0) + 1; epochs.set(key, generation);
    for (const [state, flow] of pending) if (keyOf(flow.cfg) === key) pending.delete(state);
    const callback = safeUrl(redirectUri); if (callback.pathname !== "/api/mcp/oauth/callback" || callback.search) throw new Error("OAuth 回调地址不合法");
    prunePending(); if (pending.size >= 100) throw new Error("授权请求过多，请稍后重试");
    const info = await discover(cfg), old = read().records[keyOf(cfg)];
    let client;
    if (options.client_id) client = { client_id: String(options.client_id).trim(), client_secret: String(options.client_secret || ""), token_endpoint_auth_method: options.client_secret ? (info.as.token_endpoint_auth_methods_supported?.includes("client_secret_post") ? "client_secret_post" : info.as.token_endpoint_auth_methods_supported?.includes("client_secret_basic") ? "client_secret_basic" : "client_secret_post") : "none" };
    else if (old && old.issuer === info.issuer && old.redirect_uri === callback.href) client = old.client;
    else if (options.client_metadata_url && info.as.client_id_metadata_document_supported === true) client = { client_id: (() => { const u = safeUrl(options.client_metadata_url); if (u.protocol !== "https:") throw new Error("客户端元数据地址需要 HTTPS"); return u.href; })(), token_endpoint_auth_method: "none" };
    else if (info.as.registration_endpoint) client = await fetchJson(safeUrl(info.as.registration_endpoint).href, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: "OpenWorkBuddy", redirect_uris: [callback.href], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }) });
    else throw new Error("该服务需要预注册的客户端，请填写 Client ID 后授权");
    if (!client?.client_id || typeof client.client_id !== "string") throw new Error("授权服务器没有返回客户端标识");
    if (client.client_id.length > 8192 || typeof client.client_secret === "string" && client.client_secret.length > 65536) throw new Error("OAuth 客户端凭据过长");
    if (client.token_endpoint_auth_method && !["none", "client_secret_post", "client_secret_basic"].includes(client.token_endpoint_auth_method)) throw new Error("暂不支持该服务的客户端认证方式");
    const supported = Array.isArray(info.rm.scopes_supported) ? info.rm.scopes_supported : [];
    const scope = info.auth.scope || String(options.scope || "").trim() || (supported.includes("mcp") ? "mcp" : supported[0]) || "";
    if (scope.length > 4096) throw new Error("OAuth 权限范围过长");
    client = { client_id: client.client_id, client_secret: typeof client.client_secret === "string" ? client.client_secret : "", token_endpoint_auth_method: client.token_endpoint_auth_method || "none" };
    if (epochs.get(key) !== generation) throw new Error("OAuth 授权请求已撤回");
    const state = random(), verifier = random(), challengeValue = crypto.createHash("sha256").update(verifier).digest("base64url");
    const url = safeUrl(info.as.authorization_endpoint); url.searchParams.set("response_type", "code"); url.searchParams.set("client_id", client.client_id); url.searchParams.set("redirect_uri", callback.href); url.searchParams.set("state", state); url.searchParams.set("code_challenge", challengeValue); url.searchParams.set("code_challenge_method", "S256"); url.searchParams.set("resource", info.resource); if (scope) url.searchParams.set("scope", scope);
    pending.set(state, { ...info, cfg: { name: cfg.name, url: cfg.url }, generation, owner, client, redirect_uri: callback.href, scope, verifier, until: now() + TTL });
    return { authorization_url: url.href, flow_id: state, expires_at: now() + TTL, issuer: info.issuer, scope };
  }
  async function exchange(record, params) {
    const form = new URLSearchParams({ ...params, client_id: record.client.client_id, resource: record.resource });
    const headers = { "Content-Type": "application/x-www-form-urlencoded" };
    const method = record.client.token_endpoint_auth_method || "none";
    if (record.client.client_secret && method === "client_secret_post") form.set("client_secret", record.client.client_secret);
    else if (record.client.client_secret && method === "client_secret_basic") {
      const encode = (s) => new URLSearchParams({ v: s }).toString().slice(2);
      headers.Authorization = "Basic " + Buffer.from(encode(record.client.client_id) + ":" + encode(record.client.client_secret)).toString("base64");
    }
    const data = await fetchJson(record.as.token_endpoint, { method: "POST", headers, body: form.toString() });
    if (typeof data.access_token !== "string" || !data.access_token || data.access_token.length > 65536 || !/^[A-Za-z0-9._~+/-]+=*$/.test(data.access_token) || String(data.token_type).toLowerCase() !== "bearer" || typeof data.refresh_token === "string" && data.refresh_token.length > 65536) throw new Error("授权服务器没有返回有效的 Bearer 令牌");
    return { access_token: data.access_token, refresh_token: typeof data.refresh_token === "string" ? data.refresh_token : record.refresh_token || "", expires_at: Number(data.expires_in) > 0 ? now() + Number(data.expires_in) * 1000 : 0, scope: typeof data.scope === "string" ? data.scope : record.scope };
  }
  async function complete(query, owner, current = () => true) {
    prunePending(); const record = pending.get(query.state);
    if (!record || record.owner !== owner) throw new Error("授权请求已失效或不属于当前账号");
    pending.delete(query.state); inflight.set(query.state, record);
    try {
    if (!current(record.cfg)) throw new Error("连接器已改变，请重新开始授权");
    if (query.error) throw new Error("授权已取消或被服务拒绝");
    if (query.iss && query.iss !== record.issuer || record.as.authorization_response_iss_parameter_supported === true && query.iss !== record.issuer) throw new Error("OAuth 回调的授权服务器不一致");
    if (typeof query.code !== "string" || !query.code || query.code.length > 8192) throw new Error("OAuth 回调缺少授权码");
    const token = await exchange(record, { grant_type: "authorization_code", code: query.code, redirect_uri: record.redirect_uri, code_verifier: record.verifier });
    const key = keyOf(record.cfg);
    if (epochs.get(key) !== record.generation || !current(record.cfg)) throw new Error("OAuth 授权已撤回或连接器已改变");
    const data = read(); data.records[key] = { resource: record.resource, issuer: record.issuer, as: { token_endpoint: record.as.token_endpoint, revocation_endpoint: record.as.revocation_endpoint }, client: record.client, redirect_uri: record.redirect_uri, ...token }; write(data);
    return { name: record.cfg.name, url: record.cfg.url };
    } finally { inflight.delete(query.state); }
  }
  // External browsers need not share the desktop app's login cookie. The callback only
  // deposits the code; the authenticated initiating owner performs the exchange.
  function receive(query) {
    prunePending(); const record = pending.get(query.state);
    if (!record || record.received) throw new Error("授权请求已失效或已收到回调");
    if (query.iss && query.iss !== record.issuer || record.as.authorization_response_iss_parameter_supported === true && query.iss !== record.issuer) throw new Error("OAuth 回调的授权服务器不一致");
    if (!query.error && (typeof query.code !== "string" || !query.code || query.code.length > 8192)) throw new Error("OAuth 回调缺少授权码");
    record.received = { state: query.state, code: query.code, iss: query.iss, error: query.error ? "access_denied" : "" };
  }
  async function finish(state, owner, current) {
    prunePending(); const record = pending.get(state);
    if (!record || record.owner !== owner) throw new Error("授权请求已失效或不属于当前账号");
    if (!record.received) return { ready: false };
    return { ready: true, cfg: await complete(record.received, owner, current) };
  }
  function cancel(state, owner) { const record = pending.get(state) || inflight.get(state); if (record && record.owner === owner) { const key = keyOf(record.cfg); epochs.set(key, (epochs.get(key) || 0) + 1); pending.delete(state); } }
  async function token(cfg, { force = false } = {}) {
    const key = keyOf(cfg), record = read().records[key]; if (!record) return null;
    if (!force && (!record.expires_at || record.expires_at > now() + 30000)) return record.access_token;
    if (!record.refresh_token) { if (record.expires_at && record.expires_at <= now() || force) throw new Error("OAuth 授权已失效，请重新授权"); return record.access_token; }
    if (!refreshing.has(key)) { const generation = epochs.get(key) || 0; refreshing.set(key, (async () => {
      const fresh = await exchange(record, { grant_type: "refresh_token", refresh_token: record.refresh_token });
      const data = read();
      // Logout or target changes while a refresh is pending must not resurrect credentials.
      if ((epochs.get(key) || 0) !== generation || !data.records[key] || data.records[key].refresh_token !== record.refresh_token) throw new Error("OAuth 授权已撤回");
      data.records[key] = { ...record, ...fresh }; write(data); return fresh.access_token;
    })().finally(() => refreshing.delete(key))); }
    return refreshing.get(key);
  }
  function revoke(cfg) {
    const key = keyOf(cfg); epochs.set(key, (epochs.get(key) || 0) + 1);
    const data = read(); delete data.records[key]; write(data);
    for (const [state, record] of pending) if (keyOf(record.cfg) === keyOf(cfg)) pending.delete(state);
  }
  function scrub(text) {
    const values = Object.values(read().records).flatMap(r => [r.access_token, r.refresh_token, r.client?.client_secret]).filter(v => typeof v === "string" && v.length >= 8).sort((a,b) => b.length-a.length);
    let result = String(text || ""); for (const value of values) result = result.split(value).join("***"); return result;
  }
  return { begin, complete, receive, finish, cancel, token, revoke, status, discover, scrub, fetch: (url, options) => checkedFetch(url, options, security()) };
}
module.exports = { createOAuthManager, checkedFetch, challenge, resourceUrls, issuerUrls, safeUrl, jsonOf };
