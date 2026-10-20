// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 OpenWorkBuddy Contributors
"use strict";
process.on("uncaughtException", error => { console.error(error.stack || error); process.exit(1); });
const HOME = require("./lib/own-home")("checkpoint-review");
const fs = require("fs"), path = require("path"), assert = require("assert/strict");
const { mod } = require("./lib/mod"); const checkpoints = require(mod("checkpoints")), { review, revert } = require(mod("checkpoint-review"));
let count = 0; const check = (n, fn) => {fn();console.log("✓ " + n);count++;};
const root = path.join(HOME,"workspace");fs.mkdirSync(root);
function setup(name,before,after) {if(after!=null)fs.writeFileSync(path.join(root,name),after);return checkpoints.record(root,{session:"s_fixture",rel:name,tool:"edit_file",before,after});}
check("分块审查保留行号、CRLF、末尾换行；只恢复选中的块",()=>{
 const e=setup("a.txt","one\r\nold\r\nthree\r\nfour\r\nend","one\r\nnew\r\nthree\r\nfive\r\nend\n"),r=review(root,"s_fixture",e.id);assert.equal(r.current,true);assert.equal(r.hunks.length,2);assert.equal(r.hunks[0].new_line,2);
 const a=revert(root,"s_fixture",e.id,r.hunks[0].id,r.hash);assert.equal(fs.readFileSync(path.join(root,"a.txt"),"utf8"),"one\r\nold\r\nthree\r\nfive\r\nend\n");assert.equal(a.current,true);assert.equal(a.hunks[0].reverted,true);
 const b=revert(root,"s_fixture",e.id,a.hunks[1].id,a.hash);assert.equal(fs.readFileSync(path.join(root,"a.txt"),"utf8"),"one\r\nold\r\nthree\r\nfour\r\nend");
 const c=revert(root,"s_fixture",e.id,b.hunks[0].id,b.hash);assert.equal(c.current,true);assert.equal(fs.readFileSync(path.join(root,"a.txt"),"utf8"),"one\r\nnew\r\nthree\r\nfour\r\nend");
});
check("外部改动、过期版本和别人的检查点均不能覆盖",()=>{
 const e=setup("b.txt","a\nb\nc\n","a\nB\nc\n"),r=review(root,"s_fixture",e.id);assert.throws(()=>review(root,"other",e.id),/没有/);assert.throws(()=>revert(root,"s_fixture",e.id,r.hunks[0].id,"stale"),/已被/);
 fs.appendFileSync(path.join(root,"b.txt"),"manual");assert.equal(review(root,"s_fixture",e.id).current,false);assert.throws(()=>revert(root,"s_fixture",e.id,r.hunks[0].id,r.hash),/已被/);assert.ok(fs.readFileSync(path.join(root,"b.txt"),"utf8").endsWith("manual"));
});
check("新建文件回退会移除，撤销后内容回来；删除文件也能恢复",()=>{
 const e=setup("new.txt",null,"new\n"),r=review(root,"s_fixture",e.id),a=revert(root,"s_fixture",e.id,r.hunks[0].id,r.hash);assert.equal(fs.existsSync(path.join(root,"new.txt")),false);assert.equal(a.current,true);const b=revert(root,"s_fixture",e.id,a.hunks[0].id,a.hash);assert.equal(b.current,true);assert.equal(fs.readFileSync(path.join(root,"new.txt"),"utf8"),"new\n");
 const d=setup("gone.txt","old\n",null),v=review(root,"s_fixture",d.id);assert.equal(v.current,true);assert.equal(revert(root,"s_fixture",d.id,v.hunks[0].id,v.hash).current,true);assert.equal(fs.readFileSync(path.join(root,"gone.txt"),"utf8"),"old\n");
});
check("二进制、损坏快照与指向目录外的软链接拒绝审查",()=>{
 const binary=setup("binary",Buffer.from([0,1]),Buffer.from([0,2]));assert.throws(()=>review(root,"s_fixture",binary.id),/不支持/);
 const e=setup("link.txt","old","new");fs.unlinkSync(path.join(root,"link.txt"));fs.writeFileSync(path.join(HOME,"outside"),"new");fs.symlinkSync(path.join(HOME,"outside"),path.join(root,"link.txt"));assert.throws(()=>review(root,"s_fixture",e.id),/目录外/);
 const c=setup("corrupt","before","after");fs.writeFileSync(checkpoints._internals.objPath(root,c.before),"tamper");assert.throws(()=>review(root,"s_fixture",c.id),/损坏/);
});
check("快照目录或账本被替换为目录外软链接时，读取前就拒绝",()=>{
 for(const name of ["objects","checkpoints.jsonl"]){const r=path.join(HOME,"symlink-"+name);fs.mkdirSync(r);fs.writeFileSync(path.join(r,"file.txt"),"after");const e=checkpoints.record(r,{session:"s_fixture",rel:"file.txt",before:"before",after:"after"});const target=path.join(r,".history",name);fs.rmSync(target,{recursive:true,force:true});fs.symlinkSync(path.join(HOME,"outside"),target);assert.throws(()=>review(r,"s_fixture",e.id),/目录外/);}
});
console.log(`Checkpoint review: ${count} checks passed`);
