// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 OpenWorkBuddy Contributors
"use strict";
const HOME=require("./lib/own-home")("task-billing");
const fs=require("fs"),path=require("path"),assert=require("assert/strict"),{mod}=require("./lib/mod");
const task=require(mod("task-billing"));let count=0;const check=async(n,fn)=>{await fn();console.log("✓ "+n);count++;};
(async()=>{
 await check("团队只选择组织共享模型，拒绝个人 Key 和未共享渠道",()=>{const config={active_model:"hidden",providers:[{id:"private",share_members:false}],models:[{name:"hidden",channel:"private"},{name:"shared"}]};assert.equal(task.sharedModel(config).name,"shared");for(const n of ["hidden","my:own","missing"])assert.throws(()=>task.sharedModel(config,n),/共享模型/);});
 await check("并发任务的费用归属互不串线，结束后恢复个人上下文",async()=>{await Promise.all([task.withTask({billing_scope:"team",sessionId:"team"},async()=>{await new Promise(r=>setTimeout(r,20));assert.deepEqual(task.current(),{billing_scope:"team",sessionId:"team"});}),task.withTask({billing_scope:"personal",sessionId:"own"},async()=>{await new Promise(r=>setTimeout(r,10));assert.equal(task.current().billing_scope,"personal");})]);assert.equal(task.current().sessionId,"");});
 await check("费用汇总按当前账号和组织隔离，未知价格单列",()=>{const data=task.summary([{org:"a",user:"u",kind:"run",billing_scope:"team",cost:2},{org:"a",user:"u",kind:"api",billing_scope:"team",cost_unknown:true},{org:"a",user:"u",kind:"run",cost:1},{org:"b",user:"u",kind:"run",cost:99},{org:"a",user:"other",kind:"run",cost:99}],"a","u");assert.equal(task.summary([{org:"a",user:"u",kind:"run",local:true,cost:0}],"a","u").personal.unknown,1);assert.deepEqual(data,{team:{calls:2,cost:2,unknown:1},personal:{calls:1,cost:1,unknown:0}});});
 fs.mkdirSync(path.join(HOME,"data"),{recursive:true});fs.writeFileSync(path.join(HOME,"data/users.json"),JSON.stringify({users:[{username:"fixture",org:"default",salt:"fixture",hash:"fixture",role:"admin"}],tokens:{}}));
 const account=require(mod("account")),quota=require(mod("quota")),usage=require(mod("usage-store"));
 await check("真实对话与付费工具账本都记录团队/个人及任务归属",()=>{task.withTask({billing_scope:"team",sessionId:"s_team"},()=>{account.chargeRun({username:"fixture",org:"default"},{prompt:10,completion:5,calls:1,model:"fixture-model",provider:"fixture",sessionId:"s_team"});quota.record("image",{model:"fixture",provider:"fixture"});});task.withTask({billing_scope:"personal",sessionId:"s_personal"},()=>account.chargeRun({username:"fixture",org:"default"},{prompt:10,completion:5,calls:1,model:"fixture-model",provider:"fixture",sessionId:"s_personal"}));const rows=usage.read();assert.equal(rows.find(r=>r.sessionId==="s_team"&&r.kind==="run").billing_scope,"team");assert.equal(rows.find(r=>r.sessionId==="s_team"&&r.kind==="api").billing_scope,"team");assert.equal(rows.find(r=>r.sessionId==="s_personal").billing_scope,"personal");});
 console.log(`Task billing: ${count} checks passed`);
})().catch(e=>{console.error(e.stack||e);process.exitCode=1;});
