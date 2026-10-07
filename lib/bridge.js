"use strict";
/**
 * 飞书 ↔ Claude Code 桥接服务(bridge_server.py 的 Node 移植)。
 *
 *   1. 卡片按钮回调(card.action.trigger)→ 指令注入运行中的会话
 *   2. 命令消息(im.message.receive_v1)→ /list /focus /status /help 查询会话
 *
 * 长连接经 @larksuiteoapi/node-sdk WSClient(SDK 懒加载:本模块导出的
 * 纯逻辑函数可在未安装依赖时被单测引用)。是否支持卡片回调的同步返回
 * 由 spike(spike/spike-ws.js)确认,结论见 design.md D3。
 *
 * 运行:node lib/bridge.js(配置读 ~/.claude/feishu-card.json)
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { loadConfig, validateConfig } = require("./config");
const { createFeishuClient } = require("./feishu");
const scanner = require("./session-scanner");
const { pickClaudeAncestor } = require("./notify-card");

const STATE_DIR = () => path.join(os.homedir(), ".claude", "feishu-bridge");
const INBOX_DIR = () => path.join(STATE_DIR(), "inbox");
const CLAUDE_P_DIR = () => path.join(STATE_DIR(), "claude-p");
const FOCUS_FILE = () => path.join(STATE_DIR(), "focus.json");
const BRIDGE_LOG = () => path.join(STATE_DIR(), "bridge.log");

// 按钮 value.action -> 注入给 Claude Code 的指令
const ACTION_PROMPTS = {
  continue: "继续执行未完成的部分,如果有 TODO 就继续做完,完成后再简要汇报。",
  review: "对本次改动做一次代码自查,重点找 bug、边界条件、安全与性能问题,给出结论和修复建议。",
  commit: "把本次改动整理成一条规范的 git commit 并提交(不要 push)。",
  done: "本次任务已验收结束,输出简短总结即可。",
};

// 命令触发词
const LIST_ALIAS = new Set(["/list", "/ls", "/sessions", "/会话", "/会话列表", "/claude", "/ps"]);
const STATUS_ALIAS = new Set(["/status", "/状态"]);
const HELP_ALIAS = new Set(["/help", "/帮助"]);
const FOCUS_ALIAS = new Set(["/focus", "/f", "/选中", "/切换"]);
const STOP_ALIAS = new Set(["/stop", "/停止"]);
const DIFF_ALIAS = new Set(["/diff"]);
const KNOWN_COMMANDS = new Set([...LIST_ALIAS, ...STATUS_ALIAS, ...HELP_ALIAS, ...FOCUS_ALIAS, ...STOP_ALIAS, ...DIFF_ALIAS]);
// 中文自然语言兜底
const NL_LIST = [
  "有哪些会话", "会话列表", "查询会话", "查看会话", "当前会话", "在跑什么",
  "有哪些任务", "跑着什么", "列出会话",
];

const HELP_TEXT = `🧭 Claude Code 飞书助手

/list (或 /ls /会话 /claude)
    列出正在执行的 Claude Code 会话,含状态、目录、最近提问
    /list 5 显示最近 5 个会话(不限状态)

/focus <序号> (或 /f 2)
    选中某个会话,之后的按钮指令作用于它

/diff (选中会话后使用)
    查看该会话目录本轮改动的文件清单(+/- 行数)
    每个文件带「详情」按钮,点击查看单文件 diff

/status (或 /状态)
    查看当前选中的是哪个会话

选中会话后,直接输入文字即可把提示词提交给它执行;
输入「停止」(或 /stop)终止该会话。

/help
    显示本帮助

也可以直接说:「有哪些会话」「在跑什么」

会话状态:
    🔄 执行中    transcript 60 秒内有更新
    ⏸  等待输入  进程还在但已停更
    ✅ 已结束    无进程或 transcript 超过 10 分钟未更新
`;

// --------------------------------------------------------------------------- //
function log(msg) {
  const line = `[${new Date().toLocaleString("sv-SE").replace("T", " ")}] ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(STATE_DIR(), { recursive: true });
    fs.appendFileSync(BRIDGE_LOG(), `${line}\n`);
  } catch {
    // 日志失败不影响服务
  }
}

// --------------------------------------------------------------------------- //
// 命令解析(parse_command 的移植)
// --------------------------------------------------------------------------- //
/** 返回 [命令, 参数];无法识别返回 ["", ""]。 */
function parseCommand(text) {
  let raw = String(text || "").trim();
  // 去掉群聊 @ 提及:<at user_id="xxx">xxx</at> / @_user_1
  raw = raw.replace(/<at[^>]*>[\s\S]*?<\/at>/g, "").trim();
  raw = raw.replace(/@_\w+/g, "").trim();
  raw = raw.replace(/​/g, "").trim();
  if (!raw) return ["", ""];

  const first = raw.split(/\s+/)[0];
  const rest = raw.slice(first.length).trim();
  const low = first.toLowerCase();

  if (LIST_ALIAS.has(low)) return ["list", rest];
  if (STATUS_ALIAS.has(low)) return ["status", rest];
  if (HELP_ALIAS.has(low)) return ["help", rest];
  if (FOCUS_ALIAS.has(low)) return ["focus", rest];
  if (STOP_ALIAS.has(low)) return ["stop", rest];
  if (low === "停止") return ["stop", rest]; // 选中会话后的自然语言终止
  if (DIFF_ALIAS.has(low)) return ["diff", rest];
  if (low.startsWith("/") && !KNOWN_COMMANDS.has(low)) return ["unknown", first];

  // 中文自然语言
  if (NL_LIST.some((k) => raw.includes(k))) return ["list", ""];
  if (raw.includes("选中")) {
    const m = raw.match(/\d+/);
    if (m) return ["focus", m[0]];
  }
  return ["", ""];
}

// --------------------------------------------------------------------------- //
// focus 状态
// --------------------------------------------------------------------------- //
function setFocus(session, focusFile = FOCUS_FILE()) {
  fs.mkdirSync(path.dirname(focusFile), { recursive: true });
  fs.writeFileSync(
    focusFile,
    JSON.stringify(
      {
        session_id: session.session_id || "",
        cwd: session.cwd || "",
        project: session.project || "",
        status: session.status || "",
        set_at: new Date().toLocaleString("sv-SE").replace("T", " "),
      },
      null,
      2
    )
  );
}

function getFocus(focusFile = FOCUS_FILE()) {
  try {
    return JSON.parse(fs.readFileSync(focusFile, "utf8"));
  } catch {
    return null;
  }
}

/** 优先按 session_id/cwd 匹配,取不到用当前 focus。 */
async function resolveSession(sessionId, cwd, { scan, focusFile } = {}) {
  const doScan = scan || scanner.scan;
  const result = await doScan({ maxHistory: 20 });
  for (const s of result.sessions) {
    if (sessionId && s.session_id === sessionId) return s;
    if (cwd && scanner.normalizePath(s.cwd) === scanner.normalizePath(cwd)) return s;
  }
  const focus = getFocus(focusFile);
  if (focus) {
    for (const s of result.sessions) {
      if (focus.session_id && s.session_id === focus.session_id) return s;
      if (focus.cwd && scanner.normalizePath(s.cwd) === scanner.normalizePath(focus.cwd)) return s;
    }
    return focus;
  }
  return {};
}

// --------------------------------------------------------------------------- //
// 指令投递(三级:tmux → claude -p → inbox)
// --------------------------------------------------------------------------- //
function findTmuxPane(cwd, run) {
  return scanner.scanTmux(run).then((panes) => {
    if (!cwd) return null;
    const target = scanner.normalizePath(cwd);
    for (const [p, pane] of Object.entries(panes)) {
      if (p && (p === target || target.startsWith(`${p}/`))) return pane;
    }
    return null;
  });
}

/**
 * tmux 注入。run 注入契约:run(cmd, args, opts) -> Promise(成功 resolve,失败 reject);
 * 未注入时用真实 tmux(load-buffer 经 stdin 写入文本)。
 */
async function deliverToTmux(pane, text, run, opts = {}) {
  const { spawn } = require("node:child_process");
  const exec = (args, o = {}) => {
    if (run) return run("tmux", args, o);
    return new Promise((resolve, reject) => {
      const child = spawn("tmux", args, { windowsHide: true, ...o });
      child.on("error", reject);
      child.on("close", (code) =>
        code === 0 ? resolve() : reject(new Error(`tmux ${args[0]} 退出码 ${code}`))
      );
      if (o.input !== undefined) {
        child.stdin.on("error", reject);
        child.stdin.end(o.input);
      }
    });
  };
  try {
    if (opts.ctrlC) {
      await exec(["send-keys", "-t", pane, "C-c"], { timeout: 5000 });
      return true;
    }
    await exec(["load-buffer", "-b", "feishu", "-"], { input: text, timeout: 5000 });
    await exec(["paste-buffer", "-b", "feishu", "-t", pane], { timeout: 5000 });
    if (opts.enter !== false) {
      await exec(["send-keys", "-t", pane, "Enter"], { timeout: 5000 });
    }
    return true;
  } catch (e) {
    log(`tmux 注入失败: ${e.message}`);
    return false;
  }
}

/** 找 claude 可执行文件:Windows npm 安装是 .cmd shim,需按 PATHEXT 探测。 */
function resolveClaudeExe(env = process.env) {
  const candidates = ["claude", "claude.exe", "claude.cmd"];
  const exts = String(env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";");
  const pathDirs = String(env.PATH || "").split(path.delimiter);
  const tryFile = (dir, name) => {
    const full = path.join(dir, name);
    try {
      fs.accessSync(full, fs.constants.X_OK);
      return full;
    } catch {
      return "";
    }
  };
  for (const name of candidates) {
    for (const dir of pathDirs) {
      if (!dir) continue;
      const hit = tryFile(dir, name);
      if (hit) return hit;
      if (process.platform === "win32" && !path.extname(name)) {
        for (const ext of exts) {
          const hitExt = tryFile(dir, name + ext.toLowerCase());
          if (hitExt) return hitExt;
        }
      }
    }
  }
  return "";
}

function deliverToInbox(sessionId, action, text, inboxDir = INBOX_DIR()) {
  fs.mkdirSync(inboxDir, { recursive: true });
  const p = path.join(inboxDir, `${Math.floor(Date.now() / 1000)}_${action || "run"}.json`);
  fs.writeFileSync(
    p,
    JSON.stringify({ session_id: sessionId, action, prompt: text }, null, 2)
  );
  return p;
}

/**
 * 无 tmux 兜底:目标目录起 claude -p 无头会话,输出摘要回发飞书。
 * deps.execFile / deps.spawn 可注入(测试);实现用 execFile 直接跑。
 */
function deliverToClaudeP({ sessionId, action, cwd, prompt, sendText, log: logFn = log, execFileImpl = execFile }) {
  const exe = resolveClaudeExe();
  if (!exe) {
    logFn("找不到 claude 可执行文件,无法起无头会话");
    return "";
  }
  const claudePDir = CLAUDE_P_DIR();
  fs.mkdirSync(claudePDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:T]/g, "").slice(0, 15);
  const logPath = path.join(claudePDir, `${stamp}_${action || "run"}.log`);

  (async () => {
    try {
      const out = await new Promise((resolve) => {
        execFileImpl(
          exe,
          ["-p", prompt],
          { cwd: cwd || undefined, timeout: 1_800_000, windowsHide: true, maxBuffer: 10 * 1024 * 1024 },
          (err, stdout, stderr) => {
            fs.writeFileSync(
              logPath,
              `[prompt]\n${prompt}\n\n[output]\n${stdout || ""}` +
                (err ? `\n[exit ${err.code || 1}]\n${stderr || ""}` : "")
            );
            let text = String(stdout || "").trim();
            if (!text && err) text = String(stderr || "").trim() || `退出码 ${err.code || 1},详见 ${logPath}`;
            resolve(text);
          }
        );
      });
      const summary = out.slice(0, 3000) + (out.length > 3000 ? "\n…(已截断,完整输出见日志)" : "");
      const proj = path.basename((cwd || "").replace(/[\\/]+$/, "")) || cwd || "未知项目";
      await sendText(`🤖 claude -p「${action}」完成 · ${proj}\n\n${summary}`);
      logFn(`claude -p [${action}] 完成`);
    } catch (e) {
      logFn(`claude -p [${action}] 异常: ${e.message}`);
      try {
        await sendText(`⚠️ claude -p「${action}」异常:${e.message}`);
      } catch {
        // 回发失败仅记录
      }
    }
  })();
  return logPath;
}

/** 终止选中会话:tmux 发 Ctrl+C → 结束进程 pid → 失败说明。 */
async function deliverStop(sessionId, cwd, deps = {}) {
  const target = await resolveSession(sessionId, cwd, deps);
  if (target.tmux_pane) {
    if (await deliverToTmux(target.tmux_pane, "", deps.run, { ctrlC: true })) {
      return [true, `已向 tmux \`${target.tmux_pane}\` 发送 Ctrl+C 终止会话`];
    }
  }
  // Windows / VSCode 场景:hook 触发时记录了祖先进程链,链上有 claude 主进程
  if (target.session_id) {
    const ctxFile = path.join(STATE_DIR(), `session_${String(target.session_id).slice(0, 8)}.json`);
    try {
      const ctx = JSON.parse(fs.readFileSync(ctxFile, "utf8"));
      const cand = pickClaudeAncestor(ctx.ancestors);
      if (cand && cand.pid) {
        if (process.platform === "win32") {
          const runTaskkill =
            deps.run ||
            ((cmd, args) =>
              new Promise((resolve, reject) =>
                execFile(cmd, args, { timeout: 8000, windowsHide: true }, (err) => (err ? reject(err) : resolve()))
              ));
          await runTaskkill("taskkill", ["/PID", String(cand.pid), "/T", "/F"]);
          return [true, `已终止会话进程(pid ${cand.pid},claude CLI 及其子进程)`];
        }
        const kill = deps.kill || ((pid) => process.kill(pid));
        kill(cand.pid);
        return [true, `已终止会话进程(pid ${cand.pid},claude CLI)`];
      }
    } catch (e) {
      log(`按祖先链终止失败: ${e.message}`);
    }
  }

  const kill = deps.kill || ((pid) => process.kill(pid));
  if (target.pid) {
    try {
      kill(target.pid);
      return [true, `已终止会话进程(pid ${target.pid})`];
    } catch (e) {
      log(`终止进程 ${target.pid} 失败: ${e.message}`);
    }
  }
  return [false, "无法终止:会话不在 tmux 中,也没有可终止的进程(需该会话先触发一次任务结束以记录进程链)"];
}

// --------------------------------------------------------------------------- //
// 会话改动 diff 查询
// --------------------------------------------------------------------------- //
function runProc(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 8000, windowsHide: true, ...opts }, (err, stdout) =>
      resolve(err ? "" : String(stdout || ""))
    );
  });
}

/**
 * 汇总会话目录的改动文件:git diff HEAD --numstat(已跟踪)+ status --porcelain(未跟踪)。
 * 返回 [{ file, status: "M"|"A", plus, minus }],最多 limit 个。
 */
async function gitDiffFiles(cwd, run = runProc, limit = 10) {
  const opts = { cwd };
  const out = [];
  const numstat = await run("git", ["diff", "HEAD", "--numstat"], opts);
  for (const line of String(numstat || "").split("\n")) {
    if (!line.trim()) continue;
    const [plus, minus, ...rest] = line.trim().split(/\s+/);
    const file = rest.join(" ");
    if (!file) continue;
    out.push({
      file,
      status: "M",
      plus: plus === "-" ? "二进制" : `+${plus}`,
      minus: minus === "-" ? "" : `-${minus}`,
    });
  }
  const porcelain = await run("git", ["status", "--porcelain"], opts);
  const known = new Set(out.map((o) => o.file));
  for (const line of String(porcelain || "").split("\n")) {
    if (!line.trim()) continue;
    const code = line.slice(0, 2);
    const file = line.slice(3).trim();
    if (code.trim() === "??" && !known.has(file)) {
      out.push({ file, status: "A", plus: "新增", minus: "" });
    }
  }
  return out.slice(0, limit);
}

/** 单文件具体 diff;未跟踪文件走 --no-index 展示全文(截断)。 */
async function gitFileDiff(cwd, file, run = runProc, maxChars = 3000) {
  let diff = await run("git", ["diff", "HEAD", "--", file], { cwd });
  if (!diff.trim()) {
    diff = await run("git", ["diff", "--no-index", "--", "/dev/null", file], { cwd });
  }
  diff = String(diff || "").trim();
  if (!diff) return "(无改动或无法读取 diff)";
  return diff.length > maxChars ? `${diff.slice(0, maxChars)}\n…(已截断)` : diff;
}

/** A 视图卡片:文件清单 + 增删行数 + 每文件「详情」按钮。 */
function diffListCard(files, { cwd, session_id }) {
  const totalPlus = files.filter((f) => f.plus.startsWith("+")).length;
  const elements = [
    {
      tag: "markdown",
      content:
        `**🛠 会话改动**(${files.length} 个文件)\n` +
        `<font color='grey'>目录 \`${cwd}\` · 点击「详情」查看单文件 diff</font>`,
    },
    { tag: "hr" },
  ];
  files.forEach((f, i) => {
    const n = i + 1;
    const stat = f.status === "A" ? "🆕 新增" : `📝 修改 ${f.plus}${f.minus ? ` ${f.minus}` : ""}`;
    elements.push({ tag: "markdown", content: `**${n}.** \`${f.file}\` · ${stat}` });
    elements.push({
      tag: "column_set",
      flex_mode: "bisect",
      columns: [
        {
          tag: "column",
          width: "weighted",
          weight: 1,
          elements: [
            {
              tag: "button",
              text: { tag: "plain_text", content: `📄 ${n} 详情` },
              type: "default",
              size: "small",
              width: "fill",
              behaviors: [{ type: "callback", value: { action: "file_diff", cwd, session_id, file: f.file } }],
            },
          ],
        },
        { tag: "column", width: "weighted", weight: 1, elements: [] },
      ],
    });
  });
  return {
    schema: "2.0",
    config: { update_multi: true, width_mode: "fill" },
    header: {
      template: "orange",
      title: { tag: "plain_text", content: `🛠 本轮改动(${files.length} 文件,${totalPlus} 处修改)` },
    },
    body: { direction: "vertical", padding: "12px", elements },
  };
}

/**
 * 把指令/提示词投递到目标会话。返回 [是否成功注入, 说明]。
 * @param {object} deps 注入点:scan / run(tmux) / spawnClaude / kill
 */
async function deliver(action, sessionId = "", cwd = "", deps = {}, opts = {}) {
  if (action === "stop") return deliverStop(sessionId, cwd, deps);
  const prompt = opts.prompt || ACTION_PROMPTS[action];
  const target = await resolveSession(sessionId, cwd, deps);
  const targetCwd = target.cwd || cwd;

  const pane = deps.env?.CLAUDE_TMUX_PANE || target.tmux_pane || (await findTmuxPane(targetCwd, deps.run));
  if (pane) {
    if (await deliverToTmux(pane, prompt, deps.run)) {
      return [true, `已注入 tmux \`${pane}\``];
    }
  }
  if (targetCwd && fs.existsSync(targetCwd) && fs.statSync(targetCwd).isDirectory()) {
    if (deps.spawnClaude) {
      const ok = await deps.spawnClaude({ sessionId: sessionId || target.session_id || "", action, cwd: targetCwd, prompt });
      if (ok) return [true, `已在 \`${targetCwd}\` 启动 claude -p 执行,完成后结果会发回飞书`];
    } else {
      const logPath = deliverToClaudeP({
        sessionId,
        action,
        cwd: targetCwd,
        prompt,
        sendText: deps.sendText || (async () => {}),
      });
      if (logPath) return [true, `已在 \`${targetCwd}\` 启动 claude -p 执行,完成后结果会发回飞书`];
    }
  }
  const p = deliverToInbox(sessionId || target.session_id || "", action, prompt);
  return [false, `未找到可注入的会话,指令已存入队列 \`${p}\``];
}

// --------------------------------------------------------------------------- //
// 命令处理(依赖注入:replyCard/replyText/scan 便于单测)
// --------------------------------------------------------------------------- //
async function handleCommand(cmd, arg, messageId, deps) {
  const { replyCard, replyText, scan } = deps;
  const doScan = scan || scanner.scan;

  if (cmd === "list") {
    const result = await doScan({});
    const n = arg ? parseInt(String(arg).match(/\d+/)?.[0], 10) : NaN;
    if (Number.isFinite(n) && n > 0) {
      // /list N:显示最近 N 个会话(不限状态)
      const recent = result.sessions.slice(0, n);
      log(`收到 /list ${n},展示最近 ${recent.length} 个会话`);
      if (!recent.length) {
        await replyText("当前没有可显示的 Claude Code 会话。");
        return;
      }
      await replyCard(
        scanner.toCard({ ...result, sessions: recent, total: recent.length, running: recent.filter((s) => s.status === "running").length })
      );
      return;
    }
    const running = result.sessions.filter((s) => s.status === "running");
    log(`收到 /list,共 ${result.total} 个会话,仅展示执行中的 ${running.length} 个`);
    if (!running.length) {
      await replyText("当前没有正在执行的 Claude Code 会话。(提示:/list 5 可看最近 5 个)");
      return;
    }
    await replyCard(
      scanner.toCard({ ...result, sessions: running, total: running.length, running: running.length })
    );
    return;
  }

  if (cmd === "diff") {
    const target = await resolveSession("", "", deps);
    if (!target || !target.cwd) {
      await replyText("请先用 /focus 选中会话,再输入 diff 查看其改动。");
      return;
    }
    const files = await gitDiffFiles(target.cwd, deps.run);
    if (!files.length) {
      await replyText("工作区干净,该会话目录当前没有改动。");
      return;
    }
    await replyCard(diffListCard(files, { cwd: target.cwd, session_id: target.session_id }));
    return;
  }

  if (cmd === "stop") {
    const [ok, detail] = await deliver("stop", "", "", deps);
    log(`/stop -> ${detail}`);
    await replyText(ok ? `🛑 ${detail}` : `⚠️ ${detail}`);
    return;
  }

  if (cmd === "status") {
    const focus = getFocus();
    const result = await doScan({});
    if (!focus) {
      await replyText("尚未选中会话。发送 /list 查看,再用 /focus <序号> 选中。");
      return;
    }
    const cur = result.sessions.find(
      (s) => s.cwd === focus.cwd || (focus.session_id && s.session_id === focus.session_id)
    );
    if (!cur) {
      await replyText(
        `当前选中的会话 \`${focus.project}\` 已不在运行列表里。\n目录:${focus.cwd}\n选中于:${focus.set_at}\n\n发送 /list 重新选择。`
      );
      return;
    }
    await replyText(
      `🎯 当前选中\n\n` +
        `${cur.status_label} \`${cur.project}\`\n目录:${cur.cwd}\n` +
        `会话:${cur.session_id ? cur.session_id.slice(0, 8) : "—"}\n` +
        `更新于:${scanner.fmtAge(cur.age)}\ntmux:${cur.tmux_pane || "—"}\n\n选中于 ${focus.set_at}`
    );
    return;
  }

  if (cmd === "focus") {
    if (!arg) {
      await replyText("用法:/focus <序号>,序号来自 /list 返回的列表。");
      return;
    }
    const m = String(arg).match(/\d+/);
    if (!m) {
      await replyText(`没看懂序号「${arg}」。用法:/focus 2`);
      return;
    }
    const idx = parseInt(m[0], 10);
    const result = await doScan({});
    if (idx < 1 || idx > result.sessions.length) {
      await replyText(`序号 ${idx} 超出范围,当前共 ${result.sessions.length} 个会话。发送 /list 查看。`);
      return;
    }
    const target = result.sessions[idx - 1];
    setFocus(target, deps.focusFile);
    log(`/focus ${idx} -> ${target.project} (${target.cwd})`);
    await replyText(
      `🎯 已选中 #${idx}\n\n${target.status_label} \`${target.project}\`\n` +
        `目录:${target.cwd}\ntmux:${target.tmux_pane || "—"}\n\n` +
        `之后卡片上的「继续/自查/提交/结束」都会作用于它;\n` +
        `直接输入提示词可提交给它执行,输入「停止」终止该会话。`
    );
    return;
  }

  if (cmd === "help") {
    await replyText(HELP_TEXT);
    return;
  }

  if (cmd === "unknown") {
    await replyText(`未知命令 ${arg}。\n\n${HELP_TEXT}`);
  }
}

// --------------------------------------------------------------------------- //
// 飞书事件 → 动作
// --------------------------------------------------------------------------- //
async function handleCardAction(value, deps = {}) {
  const action = (value && value.action) || "";
  const sessionId = (value && value.session_id) || "";
  const cwd = (value && value.cwd) || "";

  if (action === "list") {
    const result = await (deps.scan || scanner.scan)({});
    const running = result.sessions.filter((s) => s.status === "running");
    log(`卡片内查询会话列表:共 ${result.total} 个,仅展示执行中的 ${running.length} 个`);
    if (!running.length) {
      return { toast: { type: "info", content: "当前没有正在执行的 Claude Code 会话" } };
    }
    return {
      card: {
        type: "raw",
        data: scanner.toCard({ ...result, sessions: running, total: running.length, running: running.length }),
      },
    };
  }

  if (action === "select") {
    const target = await resolveSession(sessionId, cwd, deps);
    if (!target || !target.session_id) {
      return { toast: { type: "error", content: "该会话已不存在,请重新 /list" } };
    }
    setFocus(target, deps.focusFile);
    log(`选中会话 #${value.index} -> ${target.project} (${target.cwd})`);
    // 选中后回消息明确当前作用对象(toast 之外再发一条,群聊/单聊都可见)
    if (deps.sendText) {
      await deps
        .sendText(
          `🎯 已选中 #${value.index} ${target.project || "（未知项目）"}\n` +
            `目录:${target.cwd}\n状态:${target.status_label || ""}\n` +
            `之后卡片上的「继续/自查/提交/结束」都会作用于它;\n` +
            `直接输入提示词可提交给它执行,输入「停止」终止该会话。`
        )
        .catch(() => {});
    }
    return { toast: { type: "success", content: `已选中 #${value.index} ${target.project || ""}` } };
  }

  if (action === "file_diff") {
    const file = value.file || "";
    if (!cwd || !file) {
      return { toast: { type: "error", content: "缺少文件信息" } };
    }
    const diff = await gitFileDiff(cwd, file, deps.run);
    if (deps.sendText) {
      await deps.sendText(`📄 \`${file}\` 的 diff:\n\`\`\`\n${diff.replace(/```/g, "'''")}\n\`\`\``).catch(() => {});
    }
    return { toast: { type: "success", content: "diff 已发送到会话" } };
  }

  if (!ACTION_PROMPTS[action]) {
    log(`未知 action: ${action}`);
    return { toast: { type: "error", content: `未知指令: ${action}` } };
  }

  const [ok, detail] = await deliver(action, sessionId, cwd, deps);
  log(`action=${action} -> ${detail}`);
  return {
    toast: ok
      ? { type: "success", content: `「${action}」${detail}` }
      : { type: "info", content: detail },
  };
}

// --------------------------------------------------------------------------- //
// 长连接服务入口
// --------------------------------------------------------------------------- //
/** 消息幂等:飞书可能重推同一 message_id。 */
const seenMessageIds = createSeenSet();

function createSeenSet() {
  const arr = [];
  return {
    has: (id) => arr.includes(id),
    add: (id) => {
      arr.push(id);
      if (arr.length > 200) arr.splice(0, arr.length - 50);
    },
  };
}

async function handleMessageEvent(event, deps = {}) {
  const msg = (event && event.message) || {};
  const msgId = msg.message_id || "";
  const msgType = msg.message_type || "";

  if (msgId) {
    if (seenMessageIds.has(msgId)) return {};
    seenMessageIds.add(msgId);
  }
  if (msgType !== "text") return {};

  let text = "";
  try {
    text = JSON.parse(msg.content).text || "";
  } catch {
    text = typeof msg.content === "string" ? msg.content : "";
  }

  const [cmd, arg] = parseCommand(text);
  if (!cmd) {
    // 非命令消息:已选中会话时作为提示词转发,否则静默
    const focus = deps.focusFile ? getFocus(deps.focusFile) : getFocus();
    if (focus && (focus.session_id || focus.cwd) && text.trim()) {
      log(`收到提示词,转发到选中会话(${focus.project || focus.cwd})`);
      const [ok, detail] = await deliver("prompt", "", "", deps, { prompt: text.trim() });
      if (deps.sendText) {
        await deps.sendText(`${ok ? "📨 " : "⚠️ "}${detail}`).catch(() => {});
      }
    }
    return {};
  }

  log(`收到命令 cmd=${cmd} arg=${JSON.stringify(arg)}`);

  const client = deps.client;
  const replyCard = async (card) => {
    const token = deps.getToken ? await deps.getToken() : "";
    if (!token) throw new Error("获取 access token 失败,无法回复");
    const r = await client.replyMessage({
      token,
      messageId: msgId,
      msgType: "interactive",
      content: JSON.stringify(card),
    });
    if (r.code !== 0) throw new Error(`回复卡片失败: ${JSON.stringify(r)}`);
  };
  const replyText = async (text2) => {
    const token = deps.getToken ? await deps.getToken() : "";
    if (!token) throw new Error("获取 access token 失败,无法回复");
    const r = await client.replyMessage({
      token,
      messageId: msgId,
      msgType: "text",
      content: JSON.stringify({ text: text2 }),
    });
    if (r.code !== 0) throw new Error(`回复失败: ${JSON.stringify(r)}`);
  };

  await handleCommand(cmd, arg, msgId, { ...deps, replyCard, replyText });
  return {};
}

async function startBridge(cfg) {
  // SDK 懒加载:仅在真正启动服务时要求依赖已安装
  let lark;
  try {
    lark = require("@larksuiteoapi/node-sdk");
  } catch {
    console.error("缺少依赖 @larksuiteoapi/node-sdk,请在包目录执行 npm install");
    return 1;
  }

  try {
    validateConfig(cfg);
  } catch (e) {
    console.error(`配置问题: ${e.message}`);
    return 1;
  }
  if (cfg.mode !== "app") {
    console.error("bridge 仅支持 app 模式(企业自建应用);webhook 模式无需 bridge");
    return 1;
  }

  fs.mkdirSync(STATE_DIR(), { recursive: true });
  fs.mkdirSync(INBOX_DIR(), { recursive: true });

  // 单实例守卫:飞书每个 app 只允许一条长连接,双实例会互抢事件并引发重连风暴
  const pidFile = path.join(STATE_DIR(), "bridge.pid");
  if (fs.existsSync(pidFile)) {
    const oldPid = parseInt(fs.readFileSync(pidFile, "utf8"), 10);
    if (Number.isFinite(oldPid) && oldPid !== process.pid) {
      let alive = false;
      try {
        process.kill(oldPid, 0);
        alive = true;
      } catch {
        // 僵尸 pid 文件,继续启动
      }
      if (alive) {
        console.error(`检测到已有 bridge 在运行(pid ${oldPid}),本次启动退出。`);
        console.error(`如需重启,先结束旧进程: taskkill /PID ${oldPid} /F`);
        return 2;
      }
    }
  }
  fs.writeFileSync(pidFile, String(process.pid));

  const client = createFeishuClient({});
  // token 每次经 getTenantToken 取(getTenantToken 自带缓存,过期前 60 秒自动换新),
  // 不能在启动时取一次存住——tenant_access_token 两小时就过期
  const getToken = async () => {
    try {
      return await client.getTenantToken(cfg.app_id, cfg.app_secret);
    } catch (e) {
      log(`获取 tenant_access_token 失败: ${e.message}`);
      return "";
    }
  };

  const sendText = async (text) => {
    if (!cfg.receive_id) {
      log("未配置 receive_id,跳过回发");
      return;
    }
    const token = await getToken();
    if (!token) return;
    const r = await client.sendMessage({
      token,
      receiveIdType: cfg.receive_id_type,
      receiveId: cfg.receive_id,
      msgType: "text",
      content: JSON.stringify({ text }),
    });
    if (r.code !== 0) log(`发送文本失败: ${JSON.stringify(r)}`);
  };

  const dispatcher = new lark.EventDispatcher({}).register({
    "card.action.trigger": async (data) => {
      try {
        // spike 实测:回调 payload 扁平,action.value 在顶层
        const value = (data?.action && data.action.value) || {};
        return await handleCardAction(value, { sendText });
      } catch (e) {
        log(`回调处理异常: ${e.message}`);
        return { toast: { type: "error", content: "处理失败,查看 bridge.log" } };
      }
    },

    "im.message.receive_v1": async (data) => {
      try {
        // 事件 payload 同为扁平结构,message 直接在顶层
        return await handleMessageEvent(data || {}, { client, getToken, sendText });
      } catch (e) {
        log(`消息处理异常: ${e.message}`);
        return {};
      }
    },
  });

  log("启动飞书桥接:卡片回调 + 命令消息(Node)");
  log(`Claude 目录: ${path.join(os.homedir(), ".claude")}`);
  const ws = new lark.WSClient({
    appId: cfg.app_id,
    appSecret: cfg.app_secret,
    loggerLevel: lark.logLevels ? lark.logLevels.info : undefined,
  });
  await ws.start({ eventDispatcher: dispatcher });
  log("WSClient.start 已返回,进程保持运行(等待飞书事件)…");
  return 0;
}

if (require.main === module) {
  startBridge(loadConfig({}))
    .then((code) => {
      // code!==0 才退出;start 成功后保持进程存活(WS 连接挂在事件循环上)
      if (code) process.exit(code);
    })
    .catch((e) => {
      console.error(`bridge 异常退出: ${e.message}`);
      process.exit(1);
    });
}

module.exports = {
  ACTION_PROMPTS,
  HELP_TEXT,
  parseCommand,
  setFocus,
  getFocus,
  resolveSession,
  findTmuxPane,
  deliverToTmux,
  deliverToInbox,
  resolveClaudeExe,
  deliver,
  gitDiffFiles,
  gitFileDiff,
  diffListCard,
  handleCommand,
  handleCardAction,
  handleMessageEvent,
  startBridge,
};
