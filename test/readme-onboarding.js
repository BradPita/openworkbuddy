// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 OpenWorkBuddy Contributors
"use strict";
process.on("uncaughtException", error => { console.error(error.stack || error); process.exit(1); });
const fs = require("fs"), path = require("path"), assert = require("assert/strict");
const root = path.join(__dirname, ".."), read = (file) => fs.readFileSync(path.join(root, file), "utf8");
let count = 0;
for (const [file, label, why, commercial] of [["README.md", "## 快速开始：", "## 为什么是它", "## 商用授权"], ["README.en.md", "## Quick start:", "## Why this one", "## Commercial license"]]) {
 const text = read(file), start = text.indexOf(label);
 assert.ok(start > 0 && start < text.indexOf(why) && start < text.indexOf(commercial));
 assert.ok(text.indexOf('href="#quick-start"') < start);
 const quick = text.slice(start, text.indexOf(why));
 assert.ok(quick.includes("first-report.html")); assert.ok(quick.includes("npm ci\nnpm start")); assert.ok(quick.includes("localhost:3800")); assert.ok(quick.includes("Node.js 18+"));
 assert.ok(quick.includes("Craft")); assert.ok(quick.includes("examples/quick-start/"));
 assert.match(text, /utm_source=github&amp;utm_medium=readme&amp;utm_campaign=first_result/);
 assert.ok(!text.includes('width="120"')); assert.ok(text.includes('src="docs/images/demo.gif"'));
 count++; console.log("✓ " + file + ": clear first task, prerequisites, verified-output criteria and early start link");
}
for (const [file, sections] of [["examples/quick-start/task.md", ["本周完成", "进行中", "下周计划"]], ["examples/quick-start/task.en.md", ["Completed this week", "In progress", "Next week"]]]) {
 const text = read(file); assert.ok(text.includes("first-report.html")); assert.ok(sections.every((section) => text.includes(section)));
}
assert.deepEqual(read("docs/adoption-metrics.csv").trim().split("\n").length, 1);
const metrics = read("docs/采用与反馈.md"); assert.ok(metrics.includes("缺失") && metrics.includes("分母") && metrics.includes("No first-success time or rate has been published")); count++; console.log("✓ Metrics define success, denominators and missing observations; the template contains no fabricated data");
for (const file of ["docs/index.html", "docs/zh/index.html"]) { const text = read(file); assert.match(text, /utm_source=website&amp;utm_medium=referral&amp;utm_campaign=first_result/); assert.ok(text.includes("#quick-start")); assert.ok(!text.includes("follow releases")); }
count++; console.log("✓ Website links identify the reverse direction and point to the same first-success path");
console.log(`README onboarding: ${count} checks passed`);
