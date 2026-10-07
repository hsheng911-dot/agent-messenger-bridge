"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const {
  statusOf,
  isClaudeCmd,
  normalizePath,
  scanTmux,
  scanProcesses,
  scanTranscripts,
  lastUserLine,
  transcriptCwd,
  toText,
  toCard,
  fmtAge,
} = require("../lib/session-scanner");

test("statusOf:全分支判定表", () => {
  // transcript 太久没动 —— 已结束
  assert.deepEqual(statusOf(601, true, 90), ["dead", "✅ 已结束"]);
  assert.deepEqual(statusOf(601, false, 0), ["dead", "✅ 已结束"]);
  // 执行中:60 秒内有写入 或 CPU >= 5%
  assert.deepEqual(statusOf(30, true, 0), ["running", "🔄 执行中"]);
  assert.deepEqual(statusOf(300, true, 7), ["running", "🔄 执行中"]);
  // 等待输入:进程在但停更
  assert.deepEqual(statusOf(120, true, 0), ["idle", "⏸ 等待输入"]);
  // 无进程但刚写入过:执行中
  assert.deepEqual(statusOf(30, false, 0), ["running", "🔄 执行中"]);
  // 无进程且停更:已结束
  assert.deepEqual(statusOf(120, false, 0), ["dead", "✅ 已结束"]);
});

test("isClaudeCmd:排除自身工具链与 grep", () => {
  assert.ok(isClaudeCmd("node /usr/local/bin/claude"));
  assert.ok(!isClaudeCmd("grep claude"));
  assert.ok(!isClaudeCmd("node session-scanner.js"));
  assert.ok(!isClaudeCmd("python3 notify_card.py"));
  assert.ok(!isClaudeCmd("vim notes.txt"));
});

test("normalizePath:反斜杠与尾部斜杠", () => {
  assert.equal(normalizePath("d:\\git\\demo\\"), "d:/git/demo");
  assert.equal(normalizePath("/tmp/x"), "/tmp/x");
  assert.equal(normalizePath(""), "");
});

test("scanTmux:解析 pane 输出,只收 claude/node", async () => {
  const fakeRun = async () =>
    "%3\t/d/git/demo\tclaude\n%4\t/d/git/other\tbash\n%5\t/d/git/x\tnode";
  const panes = await scanTmux(fakeRun);
  assert.deepEqual(panes, { "/d/git/demo": "%3", "/d/git/x": "%5" });
});

test("scanTmux:tmux 不存在时返回空", async () => {
  assert.deepEqual(await scanTmux(async () => ""), {});
});

test("scanProcesses:解析 ps 输出并过滤", async () => {
  const fakeRun = async (cmd, args) => {
    assert.equal(cmd, "ps");
    return [
      " 1234  1  12.3 01:20:00 node /usr/local/bin/claude",
      " 1235  1  0.0  00:10    grep claude",
      "bad line without enough parts",
    ].join("\n");
  };
  const procs = await scanProcesses(fakeRun);
  assert.equal(procs.length, 1);
  assert.equal(procs[0].pid, 1234);
  assert.equal(procs[0].cpu, 12.3);
  assert.equal(procs[0].etime, "01:20:00");
});

test("lastUserLine/transcriptCwd:兼容 fixtures 记录结构", () => {
  const p = path.join(__dirname, "fixtures", "with-tools.jsonl");
  assert.equal(lastUserLine(p), "帮我看下测试为什么挂了");
  assert.equal(transcriptCwd(p), "d:\\git\\demo");
});

test("lastUserLine:多轮会话返回最近一次提问,跳过工具结果", () => {
  const p = path.join(__dirname, "fixtures", "multi-turn.jsonl");
  assert.equal(lastUserLine(p), "最后的提问:把结果发到飞书");
});

test("lastUserLine:跳过 isMeta 注入记录", () => {
  const p = path.join(__dirname, "fixtures", "unit", "is-meta.jsonl");
  assert.equal(lastUserLine(p), "编译一份exe");
});

test("scanTranscripts:排除 subagents 目录与 agent-* 文件", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "amb-scan-"));
  const sessDir = path.join(dir, "proj-a");
  const subDir = path.join(sessDir, "subagents");
  const projB = path.join(dir, "proj-b");
  fs.mkdirSync(subDir, { recursive: true });
  fs.mkdirSync(projB, { recursive: true });
  fs.writeFileSync(path.join(sessDir, "11111111-2222-3333-4444-555555555555.jsonl"), "{}");
  fs.writeFileSync(path.join(subDir, "agent-abcdef123456.jsonl"), "{}");
  fs.writeFileSync(path.join(projB, "agent-loose.jsonl"), "{}");
  fs.writeFileSync(path.join(projB, "66666666-7777-8888-9999-000000000000.jsonl"), "{}");

  const items = scanTranscripts(8, dir);
  const ids = items.map((i) => i.session_id).sort();
  assert.deepEqual(ids, [
    "11111111-2222-3333-4444-555555555555",
    "66666666-7777-8888-9999-000000000000",
  ]);
});

test("toText/toCard:空结果与带会话结果", () => {
  const empty = { total: 0, running: 0, idle: 0, sessions: [], scanned_at: "2026-10-04 10:00:00" };
  assert.ok(toText(empty).includes("没有检测到"));
  const emptyCard = toCard(empty);
  assert.equal(emptyCard.header.template, "grey");

  const s = {
    session_id: "abcdef12-3456",
    cwd: "/d/git/demo",
    project: "demo",
    status: "running",
    status_label: "🔄 执行中",
    age: 10,
    alive: true,
    pid: 1234,
    cpu: 12.5,
    etime: "01:00:00",
    tmux_pane: "%3",
    last_question: "帮我跑测试并修复失败用例,这个问题很长很长很长很长很长很长很长很长很长很长",
  };
  const result = { total: 1, running: 1, idle: 0, has_tmux: true, sessions: [s], scanned_at: "2026-10-04 10:00:00" };
  const card = toCard(result);
  assert.equal(card.header.template, "blue");
  assert.equal(card.header.subtitle.content, "执行中 1 · 共 1");
  const btn = card.body.elements.find((e) => e.tag === "column_set").columns[0].elements[0];
  assert.equal(btn.text.content, "选中 #1");
  assert.deepEqual(btn.behaviors[0].value, {
    action: "select",
    index: 1,
    session_id: s.session_id,
    cwd: s.cwd,
  });
  assert.ok(toText(result).includes("执行中 1"));
  assert.ok(fmtAge(10).includes("10 秒前"));
});
