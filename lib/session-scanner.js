"use strict";
/**
 * 扫描本机正在执行/挂起的 Claude Code 会话(session_scanner.py 的 Node 移植)。
 * 三源交叉:进程表(ps) + tmux + transcript(~/.claude/projects 任意层级的 .jsonl)。
 *
 * 状态判定(阈值与 Python 版一致):
 *   🔄 执行中  transcript ACTIVE_SEC 内有写入,或进程 CPU >= 5%
 *   ⏸ 等待输入  进程在,但 transcript 已停更
 *   ✅ 已结束  无进程,或 transcript 超过 IDLE_SEC 未动
 *
 * 独立调试:node lib/session-scanner.js [--json]
 */

const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { cleanUserText } = require("./transcript");

// transcript 多久内有写入算「执行中」
const ACTIVE_SEC = 60;
// 进程还在但 transcript 多久没更新算「等待输入」(超过则视为已结束)
const IDLE_SEC = 600;
// 列出最近多少个历史会话
const MAX_HISTORY = 8;

const CLAUDE_DIR = () =>
  process.env.CLAUDE_CONFIG_DIR
    ? path.resolve(process.env.CLAUDE_CONFIG_DIR.replace(/^~(?=$|\/|\\)/, os.homedir()))
    : path.join(os.homedir(), ".claude");

// 自身脚本相关,扫描时排除
const SELF_MARKERS = ["session_scanner", "session-scanner", "notify_card", "notify-card", "bridge_server", "bridge.js", "feishu"];

/**
 * 统一路径分隔符为 /,便于跨平台比较;
 * Windows 文件系统大小写不敏感,统一小写(D: 与 d: 视为同一路径)。
 */
function normalizePath(p) {
  let out = String(p || "").replace(/\\/g, "/").replace(/\/+$/, "");
  if (process.platform === "win32") out = out.toLowerCase();
  return out;
}

function runCmd(cmd, args, timeout = 5000) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout) =>
        resolve(err ? "" : String(stdout || ""))
      );
    } catch {
      resolve("");
    }
  });
}

// --------------------------------------------------------------------------- //
// 进程扫描
// --------------------------------------------------------------------------- //
function isClaudeCmd(cmd) {
  const low = String(cmd).toLowerCase();
  if (!low.includes("claude")) return false;
  if (SELF_MARKERS.some((m) => low.includes(m))) return false;
  if (low.trimStart().startsWith("grep")) return false;
  return true;
}

async function scanProcesses(run = runCmd) {
  const out = await run("ps", ["-eo", "pid=,ppid=,pcpu=,etime=,command="]);
  const procs = [];
  for (const line of out.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const all = t.split(/\s+/); // 注意:JS split 无 Python maxsplit 语义,末段需手工拼回
    if (all.length < 5) continue;
    const [pidS, ppidS, cpuS, etime] = all;
    const cmd = all.slice(4).join(" ");
    if (!isClaudeCmd(cmd)) continue;
    const pid = parseInt(pidS, 10);
    if (!Number.isFinite(pid)) continue;
    const cpu = parseFloat(cpuS) || 0;
    procs.push({
      pid,
      ppid: /^\d+$/.test(ppidS) ? parseInt(ppidS, 10) : 0,
      cpu,
      etime,
      cmd: cmd.slice(0, 120),
      cwd: await procCwd(pid, run),
    });
  }
  return procs;
}

async function procCwd(pid, run = runCmd) {
  // Linux: /proc/<pid>/cwd
  try {
    return fs.readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    // 非 Linux,继续
  }
  if (process.platform === "darwin") {
    const out = await run("lsof", ["-a", "-d", "cwd", "-p", String(pid), "-Fn"]);
    for (const line of out.split("\n")) {
      if (line.startsWith("n/")) return line.slice(1);
    }
  }
  return "";
}

// --------------------------------------------------------------------------- //
// tmux 扫描
// --------------------------------------------------------------------------- //
async function scanTmux(run = runCmd) {
  const out = await run("tmux", [
    "list-panes", "-a", "-F",
    "#{pane_id}\t#{pane_current_path}\t#{pane_current_command}",
  ]);
  const result = {};
  if (!out) return result;
  for (const line of out.split("\n")) {
    const parts = line.split("\t");
    if (parts.length !== 3) continue;
    const [paneId, rawPath, cmd] = parts;
    const low = String(cmd).toLowerCase();
    if (low.includes("claude") || low.includes("node")) {
      result[normalizePath(rawPath)] = paneId;
    }
  }
  return result;
}

// --------------------------------------------------------------------------- //
// transcript 扫描
// --------------------------------------------------------------------------- //
/** 从一条 transcript 记录里抽取真实用户提问(跳过纯 tool_result 与 isMeta 注入,清理 reminder)。 */
function questionFromRecord(obj) {
  if (!obj || obj.type !== "user" || obj.isMeta) return "";
  const content = obj.message && obj.message.content;
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    for (const b of content) {
      if (b && b.type === "text") {
        text = b.text || "";
        break;
      }
      if (b && b.type === "tool_result") {
        return ""; // 纯工具结果,不是提问
      }
    }
  }
  return cleanUserText(text);
}

/** 取会话最近一次用户提问:从文件尾部向前找(只读末尾 tailBytes 字节)。 */
function lastUserLine(filePath, tailBytes = 200_000) {
  try {
    const st = fs.statSync(filePath);
    const start = Math.max(0, st.size - tailBytes);
    const len = st.size - start;
    if (len <= 0) return "";
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(filePath, "r");
    try {
      fs.readSync(fd, buf, 0, len, start);
    } finally {
      fs.closeSync(fd);
    }
    let text = buf.toString("utf8");
    if (start > 0) {
      // 丢弃开头可能被截断的半行
      const i = text.indexOf("\n");
      if (i < 0) return "";
      text = text.slice(i + 1);
    }
    for (const ln of text.split("\n").reverse()) {
      if (!ln.trim()) continue;
      try {
        const q = questionFromRecord(JSON.parse(ln));
        if (q) return q;
      } catch {
        // 坏行跳过
      }
    }
  } catch {
    // 读不到就返回空
  }
  return "";
}

function transcriptCwd(filePath) {
  try {
    // 首行可能是 queue-operation 等无 cwd 的记录,往后多看几行
    const lines = fs.readFileSync(filePath, "utf8").split("\n", 10);
    for (const ln of lines) {
      if (!ln.trim()) continue;
      try {
        const obj = JSON.parse(ln);
        if (obj && typeof obj === "object" && obj.cwd) return obj.cwd;
      } catch {
        // 坏行跳过
      }
    }
  } catch {
    // 尽力而为
  }
  return "";
}

function scanTranscripts(maxHistory = MAX_HISTORY, projectsDir) {
  const dir = projectsDir || path.join(CLAUDE_DIR(), "projects");
  const items = [];
  let walk;
  walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === "subagents") continue; // 子 agent 的 transcript,不是用户会话
        walk(full);
      } else if (e.isFile() && e.name.endsWith(".jsonl") && !e.name.startsWith("agent-")) {
        try {
          const st = fs.statSync(full);
          items.push({
            session_id: path.basename(full, ".jsonl"),
            transcript: full,
            mtime: st.mtimeMs / 1000,
            age: Date.now() / 1000 - st.mtimeMs / 1000,
          });
        } catch {
          // stat 失败跳过
        }
      }
    }
  };
  walk(dir);
  items.sort((a, b) => b.mtime - a.mtime);
  return items.slice(0, maxHistory * 2);
}

// --------------------------------------------------------------------------- //
// 汇总
// --------------------------------------------------------------------------- //
function statusOf(age, alive, cpu) {
  if (age > IDLE_SEC) return ["dead", "✅ 已结束"];
  if (alive && (age <= ACTIVE_SEC || cpu >= 5.0)) return ["running", "🔄 执行中"];
  if (alive) return ["idle", "⏸ 等待输入"];
  if (age <= ACTIVE_SEC) return ["running", "🔄 执行中"];
  return ["dead", "✅ 已结束"];
}

async function scan({
  maxHistory = MAX_HISTORY,
  run = runCmd,
  projectsDir,
  now = Date.now() / 1000,
} = {}) {
  const [procs, panes, transcripts] = await Promise.all([
    scanProcesses(run),
    scanTmux(run),
    Promise.resolve(scanTranscripts(maxHistory, projectsDir)),
  ]);

  const aliveCwds = new Set(procs.filter((p) => p.cwd).map((p) => normalizePath(p.cwd)));
  const aliveInfo = new Map(
    procs.filter((p) => p.cwd).map((p) => [normalizePath(p.cwd), p])
  );

  const sessions = [];
  const matchedCwds = new Set();

  // 1) 有 transcript 的会话
  for (const t of transcripts) {
    const rawCwd = transcriptCwd(t.transcript);
    const cwd = normalizePath(rawCwd);
    let alive = false;
    let cpu = 0;
    let pid = null;
    let etime = "";
    for (const pc of aliveCwds) {
      if (cwd && (pc === cwd || cwd.startsWith(`${pc}/`))) {
        const info = aliveInfo.get(pc);
        alive = true;
        cpu = info.cpu;
        pid = info.pid;
        etime = info.etime;
        matchedCwds.add(pc);
        break;
      }
    }
    if (!alive) alive = t.age <= ACTIVE_SEC;

    const [code, label] = statusOf(t.age, alive, cpu);
    const displayCwd = rawCwd || "（未知目录）";
    sessions.push({
      session_id: t.session_id,
      cwd: displayCwd,
      project: rawCwd ? path.basename(normalizePath(rawCwd)) || normalizePath(rawCwd) : "（未知）",
      status: code,
      status_label: label,
      age: t.age,
      alive,
      pid,
      cpu,
      etime,
      tmux_pane: panes[cwd] || "",
      last_question: lastUserLine(t.transcript),
    });
  }

  // 2) 有进程但没匹配到 transcript 的
  for (const pc of aliveCwds) {
    if (matchedCwds.has(pc)) continue;
    sessions.push({
      session_id: "",
      cwd: pc,
      project: path.basename(pc) || pc,
      status: "running",
      status_label: "🔄 执行中",
      age: 0,
      alive: true,
      pid: aliveInfo.get(pc).pid,
      cpu: aliveInfo.get(pc).cpu,
      etime: aliveInfo.get(pc).etime,
      tmux_pane: panes[pc] || "",
      last_question: "",
    });
  }

  const running = sessions.filter((s) => s.status === "running");
  const others = sessions.filter((s) => s.status !== "running");
  const ordered = running.concat(others);

  return {
    total: ordered.length,
    running: running.length,
    idle: ordered.filter((s) => s.status === "idle").length,
    has_tmux: Object.keys(panes).length > 0,
    sessions: ordered.slice(0, Math.max(maxHistory, running.length)),
    scanned_at: new Date(now * 1000).toLocaleString("sv-SE").replace("T", " "),
  };
}

// --------------------------------------------------------------------------- //
function fmtAge(sec) {
  const s = Math.floor(sec);
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

function toText(result) {
  if (!result.sessions.length) {
    return "当前没有检测到 Claude Code 会话。\n（确认 claude 正在运行,或检查 ~/.claude/projects 是否存在）";
  }
  const lines = [
    `🧭 Claude Code 会话(执行中 ${result.running} · 共 ${result.total})`,
    `扫描于 ${result.scanned_at}`,
    "",
  ];
  result.sessions.forEach((s, i) => {
    lines.push(`${i + 1}. ${s.status_label}  ${s.project}`);
    lines.push(`   目录 ${s.cwd}`);
    if ((s.status === "running" || s.status === "idle") && s.pid) {
      lines.push(`   pid ${s.pid} · cpu ${s.cpu}% · 已运行 ${s.etime}`);
    }
    if (s.tmux_pane) lines.push(`   tmux ${s.tmux_pane}`);
    if (s.session_id) lines.push(`   会话 ${s.session_id.slice(0, 8)} · 更新于 ${fmtAge(s.age)}`);
    if (s.last_question) lines.push(`   💬 ${s.last_question.replace(/\n/g, " ").slice(0, 80)}`);
    lines.push("");
  });
  lines.push("用 /focus <序号> 选中会话,之后的指令会作用于它。");
  return lines.join("\n");
}

// --------------------------------------------------------------------------- //
function toCard(result) {
  const shell = (template, title, elements, subtitle) => ({
    schema: "2.0",
    config: { update_multi: true, width_mode: "fill" },
    header: {
      template,
      title: { tag: "plain_text", content: title },
      ...(subtitle ? { subtitle: { tag: "plain_text", content: subtitle } } : {}),
    },
    body: { direction: "vertical", padding: "12px", elements },
  });

  if (!result.sessions.length) {
    return shell("grey", "🧭 没有运行中的会话", [
      {
        tag: "markdown",
        content: "当前没有检测到 Claude Code 会话。\n\n确认 `claude` 正在运行,或检查 `~/.claude/projects` 是否存在。",
      },
    ]);
  }

  const elements = [
    {
      tag: "markdown",
      content:
        `**执行中 ${result.running}** · 等待输入 ${result.idle} · 共 ${result.total}\n\n` +
        `<font color='grey'>扫描于 ${result.scanned_at}</font>`,
    },
    { tag: "hr" },
  ];

  result.sessions.forEach((s, i) => {
    const idx = i + 1;
    let q = s.last_question.replace(/\n/g, " ").replace(/```/g, "'''");
    q = q.slice(0, 70) + (q.length > 70 ? "…" : "");
    const meta = [];
    if ((s.status === "running" || s.status === "idle") && s.pid) {
      meta.push(`pid \`${s.pid}\` · cpu ${s.cpu}%`);
    }
    if (s.tmux_pane) meta.push(`tmux \`${s.tmux_pane}\``);
    meta.push(`更新于 ${fmtAge(s.age)}`);

    let block =
      `**${idx}. ${s.status_label} \`${s.project}\`**\n\n` +
      `\`${s.cwd}\`\n\n` +
      meta.join(" · ");
    if (s.session_id) block += ` · 会话 \`${s.session_id.slice(0, 8)}\``;
    if (q) block += `\n\n💬 ${q}`;

    elements.push({ tag: "markdown", content: block }, { tag: "hr" });
  });

  // 选中按钮:最多 5 个会话,两列排布
  const selectable = result.sessions.slice(0, 5);
  const selBtn = (i, s) => ({
    tag: "button",
    text: { tag: "plain_text", content: `选中 #${i}` },
    type: "default",
    size: "small",
    width: "fill",
    behaviors: [
      { type: "callback", value: { action: "select", index: i, session_id: s.session_id, cwd: s.cwd } },
    ],
  });
  for (let i = 0; i < selectable.length; i += 2) {
    const columns = selectable.slice(i, i + 2).map((s, j) => ({
      tag: "column",
      width: "weighted",
      weight: 1,
      elements: [selBtn(i + j + 1, s)],
    }));
    if (columns.length === 1) {
      columns.push({ tag: "column", width: "weighted", weight: 1, elements: [] });
    }
    elements.push({
      tag: "column_set",
      flex_mode: "bisect",
      horizontal_spacing: "8px",
      columns,
    });
  }

  elements.push({
    tag: "markdown",
    content:
      "<font color='grey'>选中后,完成卡片上的「继续/自查/提交/结束」会作用于该会话;" +
      "也可直接发送 <font color='blue'>/focus 2</font></font>",
  });

  return shell(
    "blue",
    "🧭 Claude Code 会话列表",
    elements,
    `执行中 ${result.running} · 共 ${result.total}`
  );
}

// --------------------------------------------------------------------------- //
if (require.main === module) {
  scan().then((res) => {
    if (process.argv.includes("--json")) {
      console.log(JSON.stringify(res, null, 2));
    } else {
      console.log(toText(res));
      console.log("\n--- 卡片元素数 ---", toCard(res).body.elements.length);
    }
  });
}

module.exports = {
  ACTIVE_SEC,
  IDLE_SEC,
  MAX_HISTORY,
  scan,
  scanProcesses,
  scanTmux,
  scanTranscripts,
  statusOf,
  isClaudeCmd,
  lastUserLine,
  transcriptCwd,
  normalizePath,
  fmtAge,
  toText,
  toCard,
};
