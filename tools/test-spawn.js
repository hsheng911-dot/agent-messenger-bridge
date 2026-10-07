// 临时诊断脚本:复现向导的 detached spawn,验证子进程是否存活
"use strict";
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const out = fs.openSync(path.join(os.homedir(), ".claude", "feishu-bridge", "bridge.log"), "a");
const bridge = path.resolve(__dirname, "..", "lib", "bridge.js");
const child = spawn(process.execPath, [bridge], { detached: true, stdio: ["ignore", out, out] });
child.unref();
console.log("spawned pid", child.pid);

setTimeout(() => {
  try {
    process.kill(child.pid, 0);
    console.log("after 2s: alive");
  } catch {
    console.log("after 2s: DEAD");
  }
  process.exit(0);
}, 2000);
