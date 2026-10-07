"use strict";
/**
 * transcript 轮次解析 —— notify_card.py parse_turns 的 Node 移植,语义逐条对齐:
 *   - 一轮 = 一条真实 user 消息 + 其后所有 assistant 输出(到下一条 user 之前)
 *   - tool_result 不算提问;assistant 的 tool_use 记为「🔧 调用 …」并进输出
 *   - <system-reminder> / <command-name> 注入内容被清除
 *   - assistant usage 按 message.id 去重后累加(输入含缓存写入/读取)
 *   - 最后一轮没有 AI 输出(被打断的半轮)丢弃
 *   - 会话开头没有提问的输出归入「（会话开头的输出）」轮
 *
 * 字段名与 Python 版一致(question/answer/input/output/cache_creation/cache_read),
 * 便于 fixtures 对照测试。
 */

const fs = require("node:fs");

/** 读 transcript JSONL,返回解析成功的对象列表;文件不存在返回 []。 */
function loadJsonl(path) {
  if (!path) return [];
  let raw;
  try {
    raw = fs.readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const objs = [];
  for (const ln of raw.split("\n")) {
    const t = ln.trim();
    if (!t) continue;
    try {
      objs.push(JSON.parse(t));
    } catch {
      // 跳过坏行
    }
  }
  return objs;
}

/** 抽取人类可读文本:跳过 tool_result/thinking;assistant 的 tool_use 记一笔。 */
function extractText(message, role) {
  if (!message || typeof message !== "object") return "";
  const content = message.content;

  if (typeof content === "string") return content;

  if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const btype = block.type;
      if (btype === "text") {
        parts.push(typeof block.text === "string" ? block.text : "");
      } else if (btype === "tool_use" && role === "assistant") {
        const name = block.name || "tool";
        const inp = block.input && typeof block.input === "object" ? block.input : {};
        const target = inp.file_path || inp.command || inp.pattern || "";
        parts.push(`🔧 调用 \`${name}\` ${target}`.trimEnd());
      }
      // tool_result / thinking / redacted_thinking 一律忽略
    }
    return parts.filter((p) => p && p.trim()).join("\n");
  }
  return "";
}

/**
 * 清理注入内容:system-reminder/command-name/command-message 整段移除;
 * command-args 只去标签保留内容(斜杠命令的参数是用户真正的输入)。
 */
function cleanUserText(text) {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<command-name>[\s\S]*?<\/command-name>/g, "")
    .replace(/<command-message>[\s\S]*?<\/command-message>/g, "")
    .replace(/<command-args>([\s\S]*?)<\/command-args>/g, "$1")
    .trim();
}

function parseTimestamp(ts) {
  if (typeof ts !== "string" || !ts) return null;
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? null : d;
}

function emptyTurn(ts) {
  return {
    question: "",
    answer: "",
    start: ts,
    end: ts,
    input: 0,
    output: 0,
    cache_creation: 0,
    cache_read: 0,
  };
}

/**
 * 把 transcript 按原始顺序切成轮次。返回轮次数组(由旧到新),字段:
 *   question / answer / start / end(Date|null)/ input / output / cache_creation / cache_read
 */
function parseTurns(path) {
  const objs = loadJsonl(path);
  if (!objs.length) return [];

  const turns = [];
  const seenIds = new Set(); // usage 已计入的 message.id
  const idLastText = new Map(); // message.id -> 已拼接的正文(同消息重复落盘时避免重复拼接)

  for (const obj of objs) {
    if (!obj || typeof obj !== "object") continue;
    const role = obj.type;
    if (role !== "user" && role !== "assistant") continue;
    const msg = obj.message && typeof obj.message === "object" ? obj.message : {};
    const ts = parseTimestamp(obj.timestamp);

    if (role === "user") {
      if (obj.isMeta) continue; // 斜杠命令/技能展开等注入内容,不是用户提问
      const text = cleanUserText(extractText(msg, role));
      if (!text) continue; // 纯工具结果,不是真正的提问
      turns.push({ ...emptyTurn(ts), question: text });
      continue;
    }

    if (!turns.length) {
      turns.push({ ...emptyTurn(ts), question: "（会话开头的输出）" });
    }
    const cur = turns[turns.length - 1];

    // usage 按 message.id 只计一次;同 id 的重复记录是流式增量,usage 不重复累加
    const mid = msg.id;
    if (mid && !seenIds.has(mid)) {
      seenIds.add(mid);
      const usage = msg.usage && typeof msg.usage === "object" ? msg.usage : {};
      cur.input += usage.input_tokens || 0;
      cur.output += usage.output_tokens || 0;
      cur.cache_creation += usage.cache_creation_input_tokens || 0;
      cur.cache_read += usage.cache_read_input_tokens || 0;
    }

    // 正文:每条记录都提取(后落盘的记录才带 text);展示语义取"最后一段文字回复",
    // 不拼接工具调用流水,同一消息流式重复落盘时以最新内容为准
    const text = extractText(msg, role);
    if (text) {
      const prev = mid ? idLastText.get(mid) : undefined;
      if (text !== prev) {
        cur.answer = text;
        if (mid) idLastText.set(mid, text);
      }
    }
    if (ts) cur.end = ts;
  }

  // 丢掉最后没有 AI 输出的半轮
  if (turns.length && !turns[turns.length - 1].answer) {
    turns.pop();
  }
  return turns;
}

/** 从 transcript 末尾取最近 N 轮的 (question, answer);maxTurns<=0 表示全部。 */
function recentTurns(path, maxTurns = 1) {
  const pairs = parseTurns(path).map((t) => [t.question, t.answer]);
  return maxTurns > 0 ? pairs.slice(-maxTurns) : pairs;
}

/**
 * 统计展示轮次的耗时与 token。
 * 耗时 = 各轮 (end-start) 之和(秒,不含轮间空闲);label 标注统计范围。
 */
function turnsStats(turns, wholeSession = false) {
  const st = {
    duration_sec: 0,
    input: 0,
    output: 0,
    cache_creation: 0,
    cache_read: 0,
    label: "",
  };
  for (const t of turns) {
    if (t.start && t.end) {
      st.duration_sec += Math.max(0, Math.floor((t.end - t.start) / 1000));
    }
    st.input += t.input || 0;
    st.output += t.output || 0;
    st.cache_creation += t.cache_creation || 0;
    st.cache_read += t.cache_read || 0;
  }
  st.label = wholeSession ? "整个会话" : turns.length <= 1 ? "本轮" : `最近${turns.length}轮合计`;
  return st;
}

module.exports = { parseTurns, recentTurns, turnsStats, extractText, cleanUserText };
