// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 OpenWorkBuddy Contributors
"use strict";
const HOME=require("./lib/own-home")("oauth-api");
const fs=require("fs"),path=require("path"),http=require("http"),crypto=require("crypto"),assert=require("assert/strict"),{spawn}=require("child_process"),{entry}=require("./lib/entry");
let child,provider;process.on("exit",()=>{if(child&&child.exitCode===null)child.kill("SIGKILL");});
(async()=>{
 let base,issued=0;const token="fixture-"+crypto.randomBytes(18).toString("hex"),owner=crypto.randomBytes(24).toString("hex"),member=crypto.randomBytes(24).toString("hex");
 provider=http.createServer((req,res)=>{let body="";req.on("data",d=>body+=d);req.on("end",()=>{const j=(n,o,h={})=>{res.writeHead(n,{"Content-Type":"application/json",...h});res.end(JSON.stringify(o));};
  if(req.url==="/mcp"&&req.method==="GET")return j(401,{}, {"WWW-Authenticate":'Bearer resource_metadata="'+base+'/resource"'});
  if(req.url==="/resource")return j(200,{resource:base+"/mcp",authorization_servers:[base]});
  if(req.url==="/.well-known/oauth-authorization-server")return j(200,{issuer:base,authorization_endpoint:base+"/authorize",token_endpoint:base+"/token",registration_endpoint:base+"/register",code_challenge_methods_supported:["S256"]});
  if(req.url==="/register")return j(201,{client_id:"fixture-client"});
  if(req.url==="/token"){issued++;return j(200,{access_token:token,refresh_token:token+".refresh",token_type:"Bearer",expires_in:3600});}
  if(req.method==="POST"&&req.url==="/mcp"){if(req.headers.authorization!=="Bearer "+token)return j(401,{});const rpc=JSON.parse(body);return j(200,{jsonrpc:"2.0",id:rpc.id,result:rpc.method==="tools/list"?{tools:[]}:{protocolVersion:"2025-06-18",capabilities:{},serverInfo:{name:"fixture",version:"1"}}});}j(404,{});
 });});await new Promise(r=>provider.listen(0,"127.0.0.1",r));base="http://127.0.0.1:"+provider.address().port;
 fs.mkdirSync(path.join(HOME,"data"),{recursive:true});fs.writeFileSync(path.join(HOME,"data/users.json"),JSON.stringify({users:[{username:"owner",role:"admin",org:"default",hash:"fixture",salt:"fixture"},{username:"member",role:"member",org:"default",hash:"fixture",salt:"fixture"}],tokens:{[owner]:{user:"owner",at:Date.now()},[member]:{user:"member",at:Date.now()}}}));
 fs.writeFileSync(path.join(HOME,"config.json"),JSON.stringify({workspace_dir:path.join(HOME,"workspace"),mcp_servers:[{name:"fixture",url:base+"/mcp"}],mcp_disabled:["fixture"],security:{gateway:true,url_allow_local:["127.0.0.1:*"]}}));
 child=spawn(process.execPath,[entry("server")],{stdio:["ignore","pipe","pipe"],env:{...process.env,HOST:"127.0.0.1",PORT:"0",OWB_IMPORT_HOME:path.join(HOME,"imports")}});let output="";child.stdout.on("data",d=>output+=d);child.stderr.on("data",d=>output+=d);
 const port=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{clearInterval(poll);reject(Error("isolated server startup timeout"));},60000);const poll=setInterval(()=>{const m=/已启动: http:\/\/localhost:(\d+)/.exec(output);if(m){clearTimeout(timer);clearInterval(poll);resolve(+m[1]);}else if(child.exitCode!==null){clearTimeout(timer);clearInterval(poll);reject(Error("isolated server exited"));}},100);});
 const origin="http://127.0.0.1:"+port,callback=origin+"/api/mcp/oauth/callback";
 const call=(method,url,body,auth=owner)=>new Promise((resolve,reject)=>{const r=http.request(origin+url,{method,headers:{...(auth?{Cookie:"openworkbuddy_token="+auth}:{}),...(body?{"Content-Type":"application/json"}:{})}},res=>{let text="";res.on("data",d=>text+=d);res.on("end",()=>{let data;try{data=JSON.parse(text);}catch{}resolve({status:res.statusCode,text,data,headers:res.headers});});});r.on("error",reject);r.end(body?JSON.stringify(body):undefined);});
 let count=0;const check=async(n,f)=>{await f();console.log("✓ "+n);count++;};
 await check("匿名和普通成员不能发起或移除组织授权；无效回调不回显输入",async()=>{assert.equal((await call("POST","/api/mcp/oauth/start",{name:"fixture",redirect_uri:callback},null)).status,401);for(const action of ["start","finish","cancel","remove"])assert.equal((await call("POST","/api/mcp/oauth/"+action,{name:"fixture"},member)).status,403);const r=await call("GET","/api/mcp/oauth/callback?state=unknown&code="+token,null,null);assert.equal(r.status,400);assert.ok(!r.text.includes(token));});
 await check("授权只接受当前工作台回调；外部浏览器回调无需登录且不能直接兑换",async()=>{assert.equal((await call("POST","/api/mcp/oauth/start",{name:"fixture",redirect_uri:"https://example.invalid/api/mcp/oauth/callback"})).status,400);const r=await call("POST","/api/mcp/oauth/start",{name:"fixture",redirect_uri:callback});assert.equal(r.status,200,JSON.stringify(r.data));const flow=r.data.flow_id;assert.equal((await call("POST","/api/mcp/oauth/finish",{flow_id:flow})).data.ready,false);assert.equal((await call("GET","/api/mcp/oauth/callback?state="+flow+"&code=fixture-code",null,null)).status,200);assert.equal(issued,0);const done=await call("POST","/api/mcp/oauth/finish",{flow_id:flow});assert.equal(done.status,200);assert.equal(done.data.ready,true);assert.equal(done.data.enabled,false);assert.equal(issued,1);assert.ok(!done.text.includes(token));assert.equal((await call("POST","/api/mcp/oauth/finish",{flow_id:flow})).status,400);});
 await check("状态接口不返回令牌，授权启用时不让手填 Authorization 掩盖状态",async()=>{const r=await call("GET","/api/mcp");assert.equal(r.data.servers[0].oauth.authorized,true);assert.ok(!r.text.includes(token));const edit=await call("POST","/api/mcp/credentials",{name:"fixture",rev:r.data.servers[0].rev,headers_patch:{Authorization:"Bearer other"}});assert.equal(edit.status,409);assert.match(edit.data.error,/OAuth/);});
 await check("凭据修改保护版本且不回显；逐工具权限和重连真实生效",async()=>{
  const before=(await call("GET","/api/mcp")).data.servers[0];
  const saved=await call("POST","/api/mcp/credentials",{name:"fixture",rev:before.rev,headers_patch:{"X-Fixture":"fixture-header"}});assert.equal(saved.status,200);assert.ok(!saved.text.includes("fixture-header"));
  assert.equal((await call("POST","/api/mcp/credentials",{name:"fixture",rev:before.rev,headers_patch:{"X-Fixture":"stale"}})).status,409);
  const current=(await call("GET","/api/mcp")).data.servers[0];assert.notEqual(current.rev,before.rev);assert.ok(current.header_keys.includes("X-Fixture"));
  const policy=await call("POST","/api/mcp/policy",{server:"fixture",default:"ask",tools:{read:"allow",write:"deny"}});assert.equal(policy.status,200);assert.equal(policy.data.policy.tools.write,"deny");
  assert.equal((await call("POST","/api/mcp/policy",{server:"fixture",tools:{read:"invalid"}})).status,400);
  assert.equal((await call("POST","/api/mcp/reconnect",{name:"fixture"})).status,400);
  assert.equal((await call("POST","/api/mcp/toggle",{name:"fixture",enabled:true})).status,200);
  const reconnect=await call("POST","/api/mcp/reconnect",{name:"fixture"});assert.equal(reconnect.status,200);assert.equal(reconnect.data.connected,true);
  for(const action of ["credentials","policy","reconnect"])assert.equal((await call("POST","/api/mcp/"+action,{name:"fixture"},member)).status,403);
  assert.equal((await call("GET","/api/mcp/import")).status,403);assert.equal((await call("POST","/api/mcp/import",{picks:[{source:"fixture",name:"fixture"}]})).status,403);
 });
 await check("取消和移除立即失效，不备份残留凭据",async()=>{const r=await call("POST","/api/mcp/oauth/start",{name:"fixture",redirect_uri:callback});await call("POST","/api/mcp/oauth/cancel",{flow_id:r.data.flow_id});assert.equal((await call("GET","/api/mcp/oauth/callback?state="+r.data.flow_id+"&code=fixture",null,null)).status,400);assert.equal((await call("POST","/api/mcp/oauth/remove",{name:"fixture"})).status,200);assert.equal((await call("GET","/api/mcp")).data.servers[0].oauth.authorized,false);assert.ok(!fs.readFileSync(path.join(HOME,"data/mcp-oauth.json"),"utf8").includes(token));assert.equal(fs.existsSync(path.join(HOME,"data/mcp-oauth.json.bak")),false);});
 child.kill("SIGINT");await new Promise(r=>child.once("exit",r));await new Promise(r=>provider.close(r));console.log(`OAuth API: ${count} checks passed`);
})().catch(e=>{console.error(e.stack||e);if(child&&child.exitCode===null)child.kill("SIGKILL");if(provider)provider.close();process.exitCode=1;});
