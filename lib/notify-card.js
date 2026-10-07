#!/usr/bin/env node
"use strict";
/**
 * Claude Code Stop hook → 飞书交互卡片(notify_card.py 的 Node 移植)。
 *
 * 用法(hook 配置):
 *   node <安装目录>/lib/notify-card.js
 *
 * 配置:`~/.claude/feishu-card.json`(环境变量可覆盖,见 lib/config.js)。
 * 模式:
 *   webhook — 群自定义机器人,按钮降级 open_url(无回调)
 *   app     — 企业自建应用,四按钮回传,配合 lib/bridge.js 使用
 *
 * 铁律:任何失败都不允许非零退出或抛异常中断 Claude Code。
 */

const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadConfig, validateConfig } = require("./config");
const { createFeishuClient } = require("./feishu");
const { parseTurns, turnsStats } = require("./transcript");

const STATE_DIR = () => path.join(os.homedir(), ".claude", "feishu-bridge");

function log(msg) {
  console.error(`[feishu-card] ${msg}`);
  // hook 的 stderr 不可见,持久化一份便于排障
  try {
    const dir = STATE_DIR();
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      path.join(dir, "notify.log"),
      `[${new Date().toLocaleString("sv-SE").replace("T", " ")}] ${msg}\n`
    );
  } catch {
    // 日志失败不影响主流程
  }
}

// --------------------------------------------------------------------------- //
// 基础工具
// --------------------------------------------------------------------------- //
function readHookInput(stdin) {
  try {
    const raw = String(stdin || "").trim();
    if (!raw) return {};
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" && !Array.isArray(obj) ? obj : {};
  } catch {
    return {};
  }
}

function truncate(text, limit = 900) {
  const t = (text || "").trim();
  return t.length <= limit ? t : `${t.slice(0, limit)}\n…(已截断)`;
}

function fmtTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n ?? 0);
}

function fmtDuration(sec) {
  const s = Math.floor(sec);
  if (s < 60) return `${s}秒`;
  if (s < 3600) return `${Math.floor(s / 60)}分${s % 60}秒`;
  return `${Math.floor(s / 3600)}小时${Math.floor((s % 3600) / 60)}分`;
}

// --------------------------------------------------------------------------- //
// 去抖
// --------------------------------------------------------------------------- //
/** 命中窗口返回 true(跳过发送)。sec<=0 禁用。 */
function debounced(sessionId, sec, stateDir = STATE_DIR(), now = Date.now() / 1000) {
  if (sec <= 0) return false;
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    const stamp = path.join(stateDir, `.last_${String(sessionId).slice(0, 8)}`);
    if (fs.existsSync(stamp)) {
      const last = parseFloat(fs.readFileSync(stamp, "utf8"));
      if (Number.isFinite(last) && now - last < sec) return true;
    }
    fs.writeFileSync(stamp, String(now));
  } catch {
    // 状态目录不可写时不因去抖失败而丢通知
  }
  return false;
}

// --------------------------------------------------------------------------- //
// git 信息
// --------------------------------------------------------------------------- //
function gitInfo(cwd, runner = execFile) {
  return new Promise((resolve) => {
    const run = (args) =>
      new Promise((res) => {
        if (!runner) return res("");
        runner("git", args, { cwd: cwd || ".", timeout: 5000 }, (err, stdout) =>
          res(err ? "" : String(stdout || "").trim())
        );
      });
    (async () => {
      const branch = (await run(["rev-parse", "--abbrev-ref", "HEAD"])) || "-";
      const dirty = await run(["status", "--porcelain"]);
      resolve([branch, dirty ? "有未提交改动" : "工作区干净"]);
    })();
  });
}

// --------------------------------------------------------------------------- //
// 卡片构造(纯函数,便于单测)
// --------------------------------------------------------------------------- //
/** 四个操作按钮的两列排布(list 单独一行)。 */
function buttonColumns(btn) {
  return [
    {
      tag: "column_set",
      flex_mode: "bisect",
      horizontal_spacing: "8px",
      columns: [
        { tag: "column", width: "weighted", weight: 1, elements: [btn("▶ 继续", "continue", "primary_filled")] },
        { tag: "column", width: "weighted", weight: 1, elements: [btn("🔍 自查", "review")] },
      ],
    },
    {
      tag: "column_set",
      flex_mode: "bisect",
      horizontal_spacing: "8px",
      columns: [
        { tag: "column", width: "weighted", weight: 1, elements: [btn("📦 提交", "commit")] },
        { tag: "column", width: "weighted", weight: 1, elements: [btn("✅ 结束", "done", "danger")] },
      ],
    },
    {
      tag: "column_set",
      flex_mode: "bisect",
      horizontal_spacing: "8px",
      columns: [
        { tag: "column", width: "weighted", weight: 1, elements: [btn("🧭 全部会话", "list", "text")] },
        { tag: "column", width: "weighted", weight: 1, elements: [] },
      ],
    },
  ];
}

// --------------------------------------------------------------------------- //
// 提问中的本地图片:提取标记、上传并转成卡片 img 元素
// --------------------------------------------------------------------------- //
const IMAGE_MARKER = /\[Image: source: ([^\]]+)\]/g;

/** 拆出提问里的图片标记与其余文字。 */
function splitQuestionImages(question) {
  const paths = [];
  let m;
  IMAGE_MARKER.lastIndex = 0;
  while ((m = IMAGE_MARKER.exec(question)) !== null) {
    paths.push(m[1].trim());
  }
  const clean = question.replace(IMAGE_MARKER, "").replace(/\n{3,}/g, "\n\n").trim();
  return { clean, paths };
}

/**
 * 上传提问里的图片(最多 maxImages 张,单张 ≤10MB,文件需存在)。
 * 返回 [{ path, img_key }];失败的项自动跳过。
 */
async function uploadQuestionImages(paths, client, token, maxImages = 2) {
  const uploaded = [];
  for (const p of paths.slice(0, maxImages)) {
    try {
      if (!fs.existsSync(p)) continue;
      if (fs.statSync(p).size > 10 * 1024 * 1024) continue;
      const img_key = await client.uploadImage({ token, filePath: p });
      uploaded.push({ path: p, img_key });
    } catch (e) {
      log(`图片上传失败(${p}): ${e.message}`);
    }
  }
  return uploaded;
}

function buildCard(ctx, mode, opts = {}) {
  const sid = ctx.session_id;

  const btn = (text, action, style = "default") => {
    const b = {
      tag: "button",
      text: { tag: "plain_text", content: text },
      type: style,
      size: "medium",
      width: "fill",
    };
    if (mode === "app") {
      b.behaviors = [{ type: "callback", value: { action, session_id: sid } }];
    } else {
      const link = String(opts.btn_link || "").trim();
      if (link) b.behaviors = [{ type: "open_url", default_url: link }];
    }
    return b;
  };

  const codeBlock = (text, limit) => {
    const body = truncate(text, limit).replace(/```/g, "'''");
    return body ? `\`\`\`\n${body}\n\`\`\`` : "```\n（空）\n```";
  };

  const maxChars = opts.max_chars || 1200;
  const turns = ctx.turns || [];

  const elements = [
    {
      tag: "markdown",
      content:
        `**项目** \`${ctx.project}\`\n\n` +
        `**分支** \`${ctx.branch}\` · ${ctx.git_status}\n\n` +
        `**时间** ${ctx.time} · **会话** \`${String(sid).slice(0, 8)}\``,
    },
    { tag: "hr" },
  ];

  const st = ctx.stats || {};
  if (st.output || st.input) {
    const totalIn = (st.input || 0) + (st.cache_creation || 0) + (st.cache_read || 0);
    const label = st.label || "本轮";
    elements.splice(1, 0, {
      tag: "markdown",
      content:
        `**⏱ ${label}耗时** ${fmtDuration(st.duration_sec || 0)} · ` +
        `**🔢 Token** 输入(含缓存) ${fmtTokens(totalIn)} · ` +
        `输出 ${fmtTokens(st.output || 0)}`,
    });
  }

  if (turns.length) {
    const n = turns.length;
    turns.forEach((entry, idx) => {
      const i = idx + 1;
      const [rawQuestion, answer] = entry;
      const label = n > 1 ? `第 ${i}/${n} 轮` : "本轮对话";
      // 图片标记拆出:文字进代码块,图片以 img 元素展示
      const { clean: qText, paths } = splitQuestionImages(rawQuestion || "");
      const uploaded = (opts.questionImages && opts.questionImages.get(idx)) || [];
      const uploadedPaths = new Set(uploaded.map((u) => u.path));
      elements.push(
        { tag: "markdown", content: `**🙋 用户提问**（${label}）` },
        { tag: "markdown", content: codeBlock(qText || "（图片提问）", 600) }
      );
      for (const u of uploaded) {
        elements.push({
          tag: "img",
          img_key: u.img_key,
          alt: { tag: "plain_text", content: path.basename(u.path) },
        });
      }
      const missed = paths.filter((p) => !uploadedPaths.has(p));
      if (missed.length) {
        elements.push({
          tag: "markdown",
          content: `<font color='grey'>（${missed.length} 张图片未能上传,原图:${missed.join(", ")}）</font>`,
        });
      }
      elements.push(
        { tag: "markdown", content: "**🤖 AI 输出**" },
        { tag: "markdown", content: codeBlock(answer, maxChars) }
      );
      if (i < n) elements.push({ tag: "hr" });
    });
  } else {
    elements.push({
      tag: "markdown",
      content: `**🤖 AI 输出**\n${codeBlock(ctx.summary, maxChars)}`,
    });
  }

  if (mode === "app") {
    elements.push(
      { tag: "hr" },
      ...buttonColumns(btn),
      {
        tag: "markdown",
        content: "<font color='grey'>点击后指令会注入到运行中的 Claude Code 会话</font>",
      }
    );
  } else if (String(opts.btn_link || "").trim()) {
    // webhook 配了跳转链接:按钮降级为 open_url
    elements.push({ tag: "hr" }, ...buttonColumns(btn));
  } else {
    elements.push(
      { tag: "hr" },
      {
        tag: "markdown",
        content:
          "<font color='orange'>当前为「自定义机器人」模式,按钮点击**不会产生回调**。" +
          "改用企业自建应用即可启用交互按钮。</font>",
      }
    );
  }
  return {
    schema: "2.0",
    config: { update_multi: true, width_mode: "fill" },
    header: {
      template: "turquoise",
      title: { tag: "plain_text", content: "✅ Claude Code 任务完成" },
      subtitle: { tag: "plain_text", content: ctx.project },
    },
    body: { direction: "vertical", padding: "12px", elements },
  };
}

// --------------------------------------------------------------------------- //
// 会话上下文落盘(供 bridge 定位会话;含祖先进程链,供「停止」终止会话)
// --------------------------------------------------------------------------- //
/** 查询单个进程信息(win32 走 PowerShell,POSIX 走 ps)。 */
function queryProcessMap() {
  if (process.platform === "win32") {
    return new Promise((resolve) => {
      execFile(
        "powershell",
        ["-NoProfile", "-Command",
          "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress"],
        { timeout: 8000, windowsHide: true },
        (err, stdout) => {
          if (err || !String(stdout || "").trim()) return resolve(new Map());
          try {
            let arr = JSON.parse(String(stdout));
            if (!Array.isArray(arr)) arr = [arr];
            const map = new Map(
              arr.map((p) => [p.ProcessId, { pid: p.ProcessId, ppid: p.ParentProcessId, cmd: String(p.CommandLine || "") }])
            );
            resolve(map);
          } catch {
            resolve(new Map());
          }
        }
      );
    });
  }
  return Promise.resolve(new Map()); // POSIX 走逐级 ps 查询
}

function queryProcessPosix(pid) {
  return new Promise((resolve) => {
    execFile("ps", ["-o", "ppid=,command=", "-p", String(pid)], { timeout: 5000 }, (err, stdout) => {
      const t = String(stdout || "").trim();
      if (err || !t) return resolve(null);
      const sp = t.indexOf(" ");
      resolve(sp > 0 ? { pid, ppid: parseInt(t.slice(0, sp), 10), cmd: t.slice(sp + 1) } : null);
    });
  });
}

/**
 * 从当前 hook 进程向上收集祖先链(最多 6 级):
 * hook 由 claude CLI 经 shell 派生,链上必然有 claude 主进程。
 */
async function collectAncestors() {
  const out = [];
  if (process.platform === "win32") {
    const map = await queryProcessMap();
    let pid = process.ppid;
    for (let i = 0; i < 6 && pid && map.has(pid); i++) {
      const info = map.get(pid);
      out.push(info);
      pid = info.ppid;
    }
    return out;
  }
  let pid = process.ppid;
  for (let i = 0; i < 6 && pid && pid > 0; i++) {
    const info = await queryProcessPosix(pid);
    if (!info) break;
    out.push(info);
    pid = info.ppid;
  }
  return out;
}

/** 从祖先链里挑 claude 主进程:命令行含 claude 的最高祖先。 */
function pickClaudeAncestor(ancestors) {
  const hits = (ancestors || []).filter((a) => String(a.cmd || "").toLowerCase().includes("claude"));
  return hits.length ? hits[hits.length - 1] : null;
}

function writeSessionContext(sessionId, cwd, timeStr, stateDir = STATE_DIR(), ancestors = []) {
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, `session_${String(sessionId).slice(0, 8)}.json`),
      JSON.stringify({ session_id: sessionId, cwd, time: timeStr, ancestors }, null, 2)
    );
  } catch {
    // 落盘失败不影响主流程
  }
}

// --------------------------------------------------------------------------- //
// 主流程
// --------------------------------------------------------------------------- //
async function main({ stdin = "", env = process.env } = {}) {
  let cfg;
  try {
    cfg = validateConfig(loadConfig({ env }));
  } catch (e) {
    log(`配置问题: ${e.message}`);
    return 0;
  }

  const hook = readHookInput(stdin);
  const sessionId =
    hook.session_id || env.CLAUDE_SESSION_ID || "unknown";

  if (debounced(sessionId, cfg.debounce_sec)) {
    log("命中去抖窗口,跳过本次通知");
    return 0;
  }

  const cwd = env.CLAUDE_PROJECT_DIR || hook.cwd || process.cwd();
  const [branch, gitStatus] = await gitInfo(cwd);

  const maxTurns = cfg.turns;
  const shown = parseTurns(hook.transcript_path);
  const shownWindow = maxTurns > 0 ? shown.slice(-maxTurns) : shown;
  const turns = shownWindow.map((t) => [t.question, t.answer]);

  const ctx = {
    session_id: sessionId,
    project: path.basename(cwd.replace(/[\\/]+$/, "")) || cwd,
    branch,
    git_status: gitStatus,
    time: new Date().toLocaleString("sv-SE").replace("T", " "),
    summary:
      hook.last_assistant_message ||
      (turns.length ? turns[turns.length - 1][1] : "（无摘要）"),
    turns,
    stats: turnsStats(shownWindow, maxTurns === 0),
  };
  log(`解析到 ${turns.length} 轮对话 (turns=${maxTurns})`);

  const client = createFeishuClient({});

  // app 模式:上传提问中的本地图片,卡片里直接展示(失败降级为文字说明)
  let questionImages = new Map();
  if (cfg.mode === "app" && turns.length) {
    try {
      const token = await client.getTenantToken(cfg.app_id, cfg.app_secret);
      questionImages = new Map();
      for (let i = 0; i < turns.length; i++) {
        const { paths } = splitQuestionImages(turns[i][0] || "");
        if (!paths.length) continue;
        const uploaded = await uploadQuestionImages(paths, client, token);
        if (uploaded.length) questionImages.set(i, uploaded);
      }
    } catch (e) {
      log(`图片上传跳过: ${e.message}`);
      questionImages = new Map();
    }
  }

  const card = buildCard(
    ctx,
    cfg.mode,
    { btn_link: cfg.btn_link, max_chars: cfg.max_chars, questionImages }
  );

  try {
    if (cfg.mode === "app") {
      const token = await client.getTenantToken(cfg.app_id, cfg.app_secret);
      const r = await client.sendMessage({
        token,
        receiveIdType: cfg.receive_id_type,
        receiveId: cfg.receive_id,
        msgType: "interactive",
        content: JSON.stringify(card),
      });
      if (r.code !== 0) throw new Error(`发送卡片失败: ${JSON.stringify(r)}`);
      log(`卡片已发送 (app), message_id=${r.data && r.data.message_id}`);
    } else {
      const r = await client.sendWebhook(cfg.webhook, card);
      if (r.code !== 0 && r.StatusCode !== 0) throw new Error(`webhook 返回异常: ${JSON.stringify(r)}`);
      log("卡片已发送 (webhook)");
    }
  } catch (e) {
    log(`发送失败: ${e.message}`);
  }

  const ancestors = await collectAncestors().catch(() => []);
  writeSessionContext(sessionId, cwd, ctx.time, STATE_DIR(), ancestors);
  return 0;
}

if (require.main === module) {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => (input += d));
  process.stdin.on("end", async () => {
    try {
      process.exit(await main({ stdin: input }));
    } catch (e) {
      log(`未捕获异常(仍以 0 退出): ${e.message}`);
      process.exit(0);
    }
  });
}

module.exports = { buildCard, debounced, readHookInput, fmtTokens, fmtDuration, truncate, splitQuestionImages, uploadQuestionImages, pickClaudeAncestor, collectAncestors, main };
