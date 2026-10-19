// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
"use strict";

const fs = require("fs");
const path = require("path");
const { canContinueAfterStepLimit } = require("../src/core/automation/goal");
let pass = 0, fail = 0;
function ok(name, value) {
  if (value) { pass++; console.log("  ✅", name); }
  else { fail++; console.log("  ❌", name); }
}

ok("Goal 未完成时把 100 步上限当作分段点继续", canContinueAfterStepLimit({
  goalMode: true, active: true, stopReason: "已达最大步数（100 步）", aborted: false,
}));
ok("普通执行模式不自动续过步数上限", !canContinueAfterStepLimit({
  goalMode: false, active: true, stopReason: "已达最大步数（100 步）", aborted: false,
}));
ok("用户手动停止后不自动续跑", !canContinueAfterStepLimit({
  goalMode: true, active: true, stopReason: "已达最大步数（100 步）", aborted: true,
}));
ok("目标已完成后不再续跑", !canContinueAfterStepLimit({
  goalMode: true, active: false, stopReason: "已达最大步数（100 步）", aborted: false,
}));
ok("运行时间上限仍暂停，避免盲目重跑", !canContinueAfterStepLimit({
  goalMode: true, active: true, stopReason: "已达最大运行时间（30 分钟）", aborted: false,
}));

const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const cli = fs.readFileSync(path.join(__dirname, "..", "cli.js"), "utf8");
ok("桌面端 Goal 主循环使用步数分段判定", /continueStepLimitedGoal = goalKit\.canContinueAfterStepLimit/.test(server));
ok("CLI Goal 主循环使用同一分段判定", /continueStepLimitedGoal = goalKit\.canContinueAfterStepLimit/.test(cli));

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
