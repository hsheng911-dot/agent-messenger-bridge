// 临时诊断:模拟 Stop hook 输入,直接调 notify-card 主流程,捕获 stderr 与退出码
"use strict";
const os = require("node:os");
const path = require("node:path");

const hookInput = JSON.stringify({
  session_id: "diagtest01",
  transcript_path: path.join(
    os.homedir(),
    ".claude", "projects", "d--git-claude-code-test",
    "af1b4285-c3cd-4797-9dae-661d92d78af1.jsonl"
  ),
  cwd: "d:\\git\\claude_code_test",
});

const origErr = console.error;
const logs = [];
console.error = (...a) => logs.push(a.join(" "));

require("../lib/notify-card.js")
  .main({ stdin: hookInput, env: {} })
  .then((code) => {
    console.error = origErr;
    console.log("exit code:", code);
    console.log("--- stderr 日志 ---");
    logs.forEach((l) => console.log(l));
  })
  .catch((e) => {
    console.error = origErr;
    console.log("主流程抛异常:", e.stack);
  });
