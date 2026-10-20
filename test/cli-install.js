// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Copyright (c) 2026 OpenWorkBuddy Contributors
"use strict";
const HOME = require("./lib/own-home")("cli-install");
const fs = require("fs"), path = require("path"), assert = require("assert/strict");
const { spawnSync } = require("child_process");
const { installCli, launcher } = require("../src/desktop/cli-install");
const root = path.resolve(__dirname, "..");
(async () => {
  const fakeApp = path.join(HOME, "App O'Brien 中文"), cwd = path.join(HOME, "project space");
  fs.mkdirSync(fakeApp); fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(fakeApp, "cli.js"), "console.log(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2),home:process.env.OPENWORKBUDDY_HOME}));");
  const home = path.join(HOME, "user"); fs.mkdirSync(home);
  const profile = path.join(home, ".zprofile"); fs.writeFileSync(profile, "# user config\nexport KEEP_THIS=1\n");
  const options = { appDir: fakeApp, executable: process.execPath, platform: "darwin", home, env: { PATH: "/usr/bin:/bin", SHELL: "/bin/zsh" } };
  let r = await installCli(options); assert.equal(r.ok, true);
  assert.equal((fs.statSync(r.file).mode & 0o111) > 0, true);
  let child = spawnSync(r.file, ["hello world", "a'b", "中文"], { cwd, env: { PATH: process.env.PATH, HOME: home }, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { cwd: fs.realpathSync(cwd), args: ["hello world", "a'b", "中文"], home: path.join(home, "OpenWorkBuddy") });
  child = spawnSync(r.file, [], { cwd, env: { PATH: process.env.PATH, HOME: home, OPENWORKBUDDY_HOME: cwd }, encoding: "utf8" });
  assert.equal(JSON.parse(child.stdout).home, cwd);
  await installCli(options); await installCli(options);
  assert.equal(fs.readFileSync(profile, "utf8").match(/# OpenWorkBuddy CLI launcher/g).length, 1);
  assert.ok(fs.readFileSync(profile, "utf8").startsWith("# user config\nexport KEEP_THIS=1\n"));
  fs.writeFileSync(r.file, "user-owned-command");
  assert.equal((await installCli(options)).reason, "conflict");
  assert.equal(fs.readFileSync(r.file, "utf8"), "user-owned-command");
  assert.equal((await installCli({ ...options, env: { OPENWORKBUDDY_INSTALL_CLI: "0" } })).reason, "disabled");
  assert.equal((await installCli({ ...options, appDir: HOME })).reason, "missing-entry");
  let command;
  r = await installCli({ ...options, platform: "win32", env: { LOCALAPPDATA: path.join(HOME, "Win O'Brien") }, runCommand: async (bin, args) => { command = { bin, args }; } });
  assert.equal(r.ok, true); assert.equal(command.bin, "powershell.exe");
  const ps = Buffer.from(command.args.at(-1), "base64").toString("utf16le");
  assert.ok(ps.includes("O''Brien") && ps.includes("'Path','User'") && ps.includes("SendMessageTimeout"));
  const cmd = fs.readFileSync(r.file, "utf8");
  assert.ok(cmd.includes("chcp 65001") && cmd.includes("chcp %_owb_cli_cp%") && cmd.includes("ELECTRON_RUN_AS_NODE=1") && cmd.includes("%*") && !/\bcd\b/i.test(cmd));
  assert.ok(launcher({ platform: "win32", executable: "C:\\100%\\App.exe", cli: "C:\\a!b\\cli.js" }).includes("100%%"));
  if (process.platform === "darwin") {
    fs.unlinkSync(path.join(home, ".local", "bin", "openworkbuddy"));
    r = await installCli({ ...options, appDir: root, executable: require("electron") });
    const version = spawnSync(r.file, ["--version"], { cwd, env: { PATH: "/usr/bin:/bin", HOME: home, OPENWORKBUDDY_HOME: HOME }, encoding: "utf8", timeout: 20000 });
    assert.equal(version.status, 0, version.stderr);
    assert.equal(version.stdout.trim(), "OpenWorkBuddy " + require("../package.json").version);
    console.log("✓ Bundled Electron runs the CLI with no system Node on PATH");
  }
  console.log("✓ CLI registration: arguments, launch directory, data root, profile preservation, repeated registration, conflicts, Windows PATH and opt-out");
})().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
