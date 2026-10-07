"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  parseCommand,
  setFocus,
  getFocus,
  resolveSession,
  deliverToInbox,
  deliverToTmux,
  deliver,
  handleCommand,
  handleCardAction,
} = require("../lib/bridge");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "amb-bridge-"));

// ---------- parseCommand 全分支 ----------
test("parseCommand:命令与别名", () => {
  assert.deepEqual(parseCommand("/list"), ["list", ""]);
  assert.deepEqual(parseCommand("/ls"), ["list", ""]);
  assert.deepEqual(parseCommand("/会话"), ["list", ""]);
  assert.deepEqual(parseCommand("/status"), ["status", ""]);
  assert.deepEqual(parseCommand("/状态"), ["status", ""]);
  assert.deepEqual(parseCommand("/help"), ["help", ""]);
  assert.deepEqual(parseCommand("/f 2"), ["focus", "2"]);
  assert.deepEqual(parseCommand("/focus 10"), ["focus", "10"]);
  assert.deepEqual(parseCommand("/选中 3"), ["focus", "3"]);
});

test("parseCommand:群聊 @ 提及剥离", () => {
  assert.deepEqual(parseCommand('<at user_id="ou_1">@张三</at> /list'), ["list", ""]);
  assert.deepEqual(parseCommand("@_user_1 /status"), ["status", ""]);
  assert.deepEqual(parseCommand("<at user_id=\"ou_1\">@张三</at> 有哪些会话"), ["list", ""]);
});

test("parseCommand:中文自然语言兜底", () => {
  assert.deepEqual(parseCommand("有哪些会话"), ["list", ""]);
  assert.deepEqual(parseCommand("在跑什么"), ["list", ""]);
  assert.deepEqual(parseCommand("帮我选中 2 号"), ["focus", "2"]);
});

test("parseCommand:未知斜杠命令与普通文本", () => {
  assert.deepEqual(parseCommand("/nope arg"), ["unknown", "/nope"]);
  assert.deepEqual(parseCommand("随便聊聊今天天气"), ["", ""]);
  assert.deepEqual(parseCommand(""), ["", ""]);
});

test("parseCommand:停止命令", () => {
  assert.deepEqual(parseCommand("停止"), ["stop", ""]);
  assert.deepEqual(parseCommand("/stop"), ["stop", ""]);
  assert.deepEqual(parseCommand("/停止"), ["stop", ""]);
  // 非独立"停止"开头的文本不作终止命令,走提示词转发
  assert.deepEqual(parseCommand("停止更新依赖吧"), ["", ""]);
});

test("parseCommand:diff 命令(仅斜杠形式)", () => {
  assert.deepEqual(parseCommand("/diff"), ["diff", ""]);
  // 裸词不作命令,走提示词转发
  assert.deepEqual(parseCommand("diff"), ["", ""]);
  assert.deepEqual(parseCommand("改动"), ["", ""]);
});

// ---------- focus ----------
test("setFocus/getFocus:落盘与读取", () => {
  const f = path.join(tmp, "focus.json");
  setFocus({ session_id: "sid-1", cwd: "/d/git/demo", project: "demo", status: "running" }, f);
  const focus = getFocus(f);
  assert.equal(focus.session_id, "sid-1");
  assert.equal(focus.project, "demo");
  assert.ok(focus.set_at);
  assert.equal(getFocus(path.join(tmp, "nope.json")), null);
});

// ---------- resolveSession ----------
const NO_FOCUS = path.join(tmp, "no-focus.json");
const fakeSessions = [
  { session_id: "aaa", cwd: "D:/git/claude_code_test", project: "claude_code_test", status: "running", status_label: "🔄 执行中", age: 10, alive: true, pid: 1, cpu: 5, etime: "00:10", tmux_pane: "", last_question: "测试问题" },
  { session_id: "bbb", cwd: "D:/git/other", project: "other", status: "idle", status_label: "⏸ 等待输入", age: 120, alive: true, pid: 2, cpu: 0, etime: "01:00", tmux_pane: "", last_question: "" },
];
const fakeScan = async () => ({ total: 2, running: 1, sessions: fakeSessions });

test("resolveSession:session_id / cwd / focus 兜底", async () => {
  assert.equal((await resolveSession("bbb", "", { scan: fakeScan })).project, "other");
  assert.equal((await resolveSession("", "D:/git/claude_code_test", { scan: fakeScan })).session_id, "aaa");
  // focus 兜底
  const focusFile = path.join(tmp, "focus2.json");
  setFocus({ session_id: "bbb", cwd: "/d/git/other", project: "other" }, focusFile);
  assert.equal((await resolveSession("", "", { scan: fakeScan, focusFile })).session_id, "bbb");
  // 全部落空
  assert.deepEqual(await resolveSession("", "", { scan: fakeScan, focusFile: path.join(tmp, "nope.json") }), {});
});

// ---------- tmux / inbox / deliver ----------
test("deliverToTmux:三条 tmux 命令顺序执行", async () => {
  const calls = [];
  const ok = await deliverToTmux("%3", "提示词", async (cmd, args) => {
    calls.push([cmd, args[0]]);
    return "";
  });
  assert.ok(ok);
  assert.deepEqual(calls, [
    ["tmux", "load-buffer"],
    ["tmux", "paste-buffer"],
    ["tmux", "send-keys"],
  ]);
});

test("deliverToTmux:失败返回 false", async () => {
  const ok = await deliverToTmux("%3", "提示词", async () => {
    throw new Error("no tmux");
  });
  assert.ok(!ok);
});

test("deliverToInbox:落盘内容完整", () => {
  const dir = path.join(tmp, "inbox");
  const p = deliverToInbox("sid-1", "continue", "提示词", dir);
  const body = JSON.parse(fs.readFileSync(p, "utf8"));
  assert.equal(body.session_id, "sid-1");
  assert.equal(body.action, "continue");
  assert.equal(body.prompt, "提示词");
});

test("deliver:决策树 tmux > claude -p > inbox", async () => {
  // 1) tmux 命中:按钮 value 携带 cwd,匹配到 pane
  const depsTmux = {
    scan: fakeScan,
    focusFile: NO_FOCUS,
    run: async (cmd, args) =>
      args.includes("#{pane_id}\t#{pane_current_path}\t#{pane_current_command}") ? "%3\td:/git/claude_code_test\tclaude" : "",
  };
  const [okT, detailT] = await deliver("continue", "", "D:/git/claude_code_test", depsTmux);
  assert.ok(okT && detailT.includes("tmux"));

  // 2) 无 tmux,cwd 存在 → claude -p 兜底(spawnClaude 注入)
  const depsClaude = {
    scan: fakeScan,
    focusFile: NO_FOCUS,
    run: async () => "",
    spawnClaude: async ({ cwd }) => {
      assert.equal(cwd, "D:/git/claude_code_test");
      return true;
    },
  };
  const [okC, detailC] = await deliver("review", "", "D:/git/claude_code_test", depsClaude);
  assert.ok(okC && detailC.includes("claude -p"));

  // 3) 会话不存在且 cwd 不存在 → inbox
  const emptyScan = async () => ({ total: 0, running: 0, sessions: [] });
  const depsInbox = { scan: emptyScan, focusFile: NO_FOCUS, run: async () => "" };
  const [okI, detailI] = await deliver("done", "", "", depsInbox);
  assert.ok(!okI && detailI.includes("队列"));
});

test("handleCommand list:/list N 显示最近 N 个会话(不限状态)", async () => {
  const { handleCommand } = require("../lib/bridge");
  const seen = {};
  await handleCommand("list", "5", "om_3", {
    scan: async () => ({ total: 2, running: 1, sessions: fakeSessions }),
    replyCard: async (card) => (seen.card = card),
    replyText: async (t) => (seen.text = t),
  });
  assert.ok(seen.card);
  const body = JSON.stringify(seen.card);
  assert.ok(body.includes("claude_code_test"));
  assert.ok(body.includes("other")); // 不限状态,idle 的 bbb 也在
});

test("handleCommand stop:tmux 场景发 Ctrl+C,祖先链场景 taskkill,pid 场景 kill", async () => {
  const { handleCommand } = require("../lib/bridge");
  // 1) tmux:focus 匹配到带 pane 的会话 → send-keys C-c
  const seen = {};
  const focusFile1 = path.join(tmp, "focus-stop1.json");
  setFocus({ session_id: "aaa", cwd: "D:/git/claude_code_test", project: "cct" }, focusFile1);
  await handleCommand("stop", "", "om_4", {
    scan: async () => ({
      total: 1,
      running: 1,
      sessions: [{ ...fakeSessions[0], tmux_pane: "%3" }],
    }),
    focusFile: focusFile1,
    run: async () => "",
    replyText: async (t) => (seen.text = t),
  });
  assert.ok(seen.text.includes("Ctrl+C"));

  // 2) 无 tmux、无 pid:hook 祖先链里有 claude 主进程 → taskkill 任务树(win32)
  const stateDir = os.homedir() + "/.claude/feishu-bridge";
  const realCtxFile = path.join(stateDir, "session_cccccccc.json");
  const realCtx = fs.existsSync(realCtxFile) ? fs.readFileSync(realCtxFile, "utf8") : null;
  fs.writeFileSync(
    realCtxFile,
    JSON.stringify({
      session_id: "cccccccc-1",
      ancestors: [
        { pid: 100, ppid: 90, cmd: "cmd /c node hook.js" },
        { pid: 90, ppid: 80, cmd: "node C:\\cli\\claude.js" },
        { pid: 80, ppid: 70, cmd: "vscode --extension" },
      ],
    })
  );
  const seen3 = {};
  const taskkillCalls = [];
  const focusFile3 = path.join(tmp, "focus-stop3.json");
  setFocus({ session_id: "cccccccc-1", cwd: "d:/x", project: "x" }, focusFile3);
  await handleCommand("stop", "", "om_6", {
    scan: async () => ({
      total: 1,
      running: 0,
      sessions: [{ session_id: "cccccccc-1", cwd: "d:/x", project: "x", status: "running", status_label: "🔄", tmux_pane: "", pid: null }],
    }),
    focusFile: focusFile3,
    run: async (cmd, args) => {
      taskkillCalls.push([cmd, args]);
      return "";
    },
    replyText: async (t) => (seen3.text = t),
  });
  if (process.platform === "win32") {
    assert.equal(taskkillCalls.length, 1);
    assert.equal(taskkillCalls[0][0], "taskkill");
    assert.ok(taskkillCalls[0][1].includes("90")); // 命中 claude 祖先而非 cmd
    assert.ok(seen3.text.includes("已终止"));
  }

  // 3) 无 tmux:focus 匹配到带 pid 的会话 → 结束进程(kill 注入)
  const killed = [];
  const seen2 = {};
  const focusFile2 = path.join(tmp, "focus-stop2.json");
  setFocus({ session_id: "bbb", cwd: "D:/git/other", project: "other" }, focusFile2);
  await handleCommand("stop", "", "om_7", {
    scan: async () => ({
      total: 1,
      running: 0,
      sessions: [{ ...fakeSessions[1], tmux_pane: "", pid: 4321 }],
    }),
    focusFile: focusFile2,
    run: async () => {
      throw new Error("不应走到 taskkill");
    },
    kill: (pid) => killed.push(pid),
    replyText: async (t) => (seen2.text = t),
  });
  assert.deepEqual(killed, [4321]);
  assert.ok(seen2.text.includes("已终止"));

  // 恢复真实上下文文件(若原本存在)
  if (realCtx !== null) fs.writeFileSync(realCtxFile, realCtx);
  else fs.unlinkSync(realCtxFile);
});

test("提示词转发:focus 存在时非命令文本提交到选中会话", async () => {
  const { handleMessageEvent } = require("../lib/bridge");
  const focusFile = path.join(tmp, "focus-fwd.json");
  setFocus({ session_id: "aaa", cwd: "D:/git/claude_code_test", project: "cct" }, focusFile);
  const spawned = [];
  const sent = [];
  await handleMessageEvent(
    {
      message: {
        message_id: "om_fwd_1",
        message_type: "text",
        content: JSON.stringify({ text: "帮我把 README 里的安装步骤再过一遍" }),
      },
    },
    {
      focusFile,
      client: {},
      token: "tk",
      scan: fakeScan,
      sendText: async (t) => sent.push(t),
      spawnClaude: async ({ cwd, prompt, action }) => {
        spawned.push({ cwd, prompt, action });
        return true;
      },
      run: async () => "",
    }
  );
  assert.equal(spawned.length, 1);
  assert.ok(/claude_code_test/i.test(spawned[0].cwd));
  assert.ok(spawned[0].prompt.includes("README"));
  assert.equal(spawned[0].action, "prompt");
  assert.equal(sent.length, 1);
  assert.ok(sent[0].includes("claude -p"));
});

test("提示词转发:未选中会话时静默", async () => {
  const { handleMessageEvent } = require("../lib/bridge");
  const sent = [];
  const spawned = [];
  await handleMessageEvent(
    {
      message: {
        message_id: "om_fwd_2",
        message_type: "text",
        content: JSON.stringify({ text: "随便说说" }),
      },
    },
    {
      focusFile: path.join(tmp, "no-focus.json"),
      client: {},
      token: "tk",
      sendText: async (t) => sent.push(t),
      spawnClaude: async () => {
        spawned.push(1);
        return true;
      },
      run: async () => "",
    }
  );
  assert.equal(spawned.length, 0);
  assert.equal(sent.length, 0);
});

// ---------- diff 查询 ----------
const { gitDiffFiles, gitFileDiff, diffListCard } = require("../lib/bridge");

test("gitDiffFiles:解析 numstat + 未跟踪文件", async () => {
  const run = async (cmd, args, opts) => {
    if (args.includes("--numstat")) {
      return "12\t3\tlib/a.js\n-\t-\timg/logo.png\n";
    }
    if (args.includes("--porcelain")) {
      return " M lib/a.js\n?? new-file.json\n";
    }
    return "";
  };
  const files = await gitDiffFiles("D:/x", run);
  assert.deepEqual(files, [
    { file: "lib/a.js", status: "M", plus: "+12", minus: "-3" },
    { file: "img/logo.png", status: "M", plus: "二进制", minus: "" },
    { file: "new-file.json", status: "A", plus: "新增", minus: "" },
  ]);
});

test("gitDiffFiles:空输出返回空数组", async () => {
  assert.deepEqual(await gitDiffFiles("D:/x", async () => ""), []);
});

test("gitFileDiff:优先 HEAD diff,为空时回退 --no-index 并截断", async () => {
  const run = async (cmd, args) => {
    if (args.includes("HEAD")) return "";
    if (args.includes("--no-index")) return "diff --git a/new.json\n+{\n+  \"a\": 1\n}\n" + "x".repeat(4000);
    return "";
  };
  const d = await gitFileDiff("D:/x", "new.json", run, 100);
  assert.ok(d.startsWith("diff --git a/new.json"));
  assert.ok(d.includes("…(已截断)"));
});

test("diffListCard:每个文件带详情按钮,值含 cwd 与 file", () => {
  const card = diffListCard(
    [
      { file: "lib/a.js", status: "M", plus: "+12", minus: "-3" },
      { file: "new.json", status: "A", plus: "新增", minus: "" },
    ],
    { cwd: "D:/x", session_id: "s-1" }
  );
  assert.equal(card.header.title.content, "🛠 本轮改动(2 文件,1 处修改)");
  const btns = [];
  for (const e of card.body.elements) {
    if (e.tag === "column_set") {
      for (const col of e.columns) {
        for (const el of col.elements) if (el.tag === "button") btns.push(el);
      }
    }
  }
  assert.equal(btns.length, 2);
  assert.deepEqual(btns[0].behaviors[0].value, {
    action: "file_diff",
    cwd: "D:/x",
    session_id: "s-1",
    file: "lib/a.js",
  });
});

test("handleCommand diff:未选中提示,选中后回清单卡片", async () => {
  const seen1 = {};
  await handleCommand("diff", "", "om_d1", {
    scan: async () => ({ sessions: [] }),
    focusFile: path.join(tmp, "no-focus.json"),
    replyText: async (t) => (seen1.text = t),
    replyCard: async (c) => (seen1.card = c),
  });
  assert.ok(seen1.text.includes("先"));
  assert.ok(!seen1.card);

  const seen2 = {};
  const focusFile = path.join(tmp, "focus-diff.json");
  setFocus({ session_id: "aaa", cwd: "D:/git/claude_code_test", project: "cct" }, focusFile);
  await handleCommand("diff", "", "om_d2", {
    scan: fakeScan,
    focusFile,
    run: async (cmd, args) => {
      if (args.includes("--numstat")) return "12\t3\tlib/a.js\n";
      if (args.includes("--porcelain")) return "";
      return "";
    },
    replyText: async (t) => (seen2.text = t),
    replyCard: async (c) => (seen2.card = c),
  });
  assert.ok(!seen2.text);
  assert.equal(seen2.card.header.title.content, "🛠 本轮改动(1 文件,1 处修改)");
});

test("handleCardAction file_diff:回发单文件 diff", async () => {
  const sent = [];
  const resp = await handleCardAction(
    { action: "file_diff", cwd: "D:/x", file: "lib/a.js" },
    { run: async (cmd, args) => (args.includes("HEAD") ? "diff --git a/lib/a.js\n- old\n+ new" : "") }
  );
  assert.equal(resp.toast.type, "success");
  assert.deepEqual(resp.toast.content, "diff 已发送到会话");
});

test("handleCardAction:list 原地换卡片,仅显示执行中", async () => {
  const resp = await handleCardAction({ action: "list" }, { scan: fakeScan });
  assert.equal(resp.card.type, "raw");
  assert.equal(resp.card.data.header.title.content, "🧭 Claude Code 会话列表");
  // fakeSessions: aaa(running) + bbb(idle) → 卡片只含 running 的 aaa
  const body = JSON.stringify(resp.card.data);
  assert.ok(body.includes("claude_code_test"));
  assert.ok(!body.includes('"bbb"'));
  assert.equal(resp.card.data.header.subtitle.content, "执行中 1 · 共 1");
});

const noRunningScan = async () => ({
  total: 2,
  running: 0,
  sessions: fakeSessions.map((s) => ({ ...s, status: "idle", status_label: "⏸ 等待输入" })),
});

test("handleCardAction:list 无执行中会话时 toast 提示", async () => {
  const resp = await handleCardAction({ action: "list" }, { scan: noRunningScan });
  assert.equal(resp.toast.type, "info");
  assert.ok(resp.toast.content.includes("没有正在执行"));
});

test("handleCommand list:只回执行中会话卡片,无执行中时回文本", async () => {
  const { handleCommand } = require("../lib/bridge");
  const seen = {};
  await handleCommand("list", "", "om_1", {
    scan: fakeScan,
    replyCard: async (card) => (seen.card = card),
    replyText: async (t) => (seen.text = t),
  });
  assert.ok(seen.card);
  assert.equal(seen.card.header.subtitle.content, "执行中 1 · 共 1");

  const seen2 = {};
  await handleCommand("list", "", "om_2", {
    scan: noRunningScan,
    replyCard: async (card) => (seen2.card = card),
    replyText: async (t) => (seen2.text = t),
  });
  assert.ok(!seen2.card);
  assert.ok(seen2.text.includes("没有正在执行"));
});

test("handleCardAction:select 写 focus、toast 并回消息报项目", async () => {
  const focusFile = path.join(tmp, "focus3.json");
  const sent = [];
  const resp = await handleCardAction(
    { action: "select", index: 2, session_id: "bbb", cwd: "/d/git/other" },
    { scan: fakeScan, focusFile, sendText: async (t) => sent.push(t) }
  );
  assert.equal(resp.toast.type, "success");
  assert.ok(resp.toast.content.includes("other"));
  assert.equal(getFocus(focusFile).session_id, "bbb");
  assert.equal(sent.length, 1);
  assert.ok(sent[0].includes("已选中 #2"));
  assert.ok(sent[0].includes("other")); // 项目名
});

test("handleCardAction:select 目标不存在报错 toast", async () => {
  const resp = await handleCardAction(
    { action: "select", index: 9, session_id: "zzz" },
    { scan: async () => ({ sessions: [] }), focusFile: NO_FOCUS }
  );
  assert.equal(resp.toast.type, "error");
});

test("handleCardAction:未知 action", async () => {
  const resp = await handleCardAction({ action: "nope" }, { scan: fakeScan });
  assert.equal(resp.toast.type, "error");
  assert.ok(resp.toast.content.includes("未知指令"));
});
