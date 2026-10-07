"use strict";
/**
 * transcript.js 移植对照测试(任务 3.2):
 *   1. 结构断言:直接对每个 fixture 断言轮次切分/清理/去重/丢弃语义
 *   2. Python 对照:test/expected/python-parse.json 存在时,逐字段对照
 *      (由 `py -3 tools/export_expected.py` 生成;缺失时跳过并提示)
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { parseTurns, turnsStats, cleanUserText } = require("../lib/transcript");

const FIXTURES = path.join(__dirname, "fixtures");
const fx = (name) => path.join(FIXTURES, name);
const expectedFile = path.join(__dirname, "expected", "python-parse.json");

test("with-tools:tool_result 不成轮,回答取最后一段文字", () => {
  const turns = parseTurns(fx("with-tools.jsonl"));
  assert.equal(turns.length, 1);
  const t = turns[0];
  assert.equal(t.question, "帮我看下测试为什么挂了");
  // 回答只含最后一段文字回复,不含工具调用流水与中间输出
  assert.equal(t.answer, "原因找到了:断言里少了一个边界判断,已修复并复跑通过。");
  // 去重:重复 msg_a1 的 999/888 不计入
  assert.equal(t.input, 100 + 150);
  assert.equal(t.output, 50 + 80);
  assert.equal(t.cache_creation, 10 + 5);
  assert.equal(t.cache_read, 200 + 300);
  // 耗时 10:00:00 -> 10:01:00 = 60 秒
  assert.equal(turnsStats(turns).duration_sec, 60);
});

test("interrupted-half-turn:被打断的半轮被丢弃", () => {
  const turns = parseTurns(fx("interrupted-half-turn.jsonl"));
  assert.equal(turns.length, 1);
  assert.equal(turns[0].question, "第一轮:把README改一下");
  assert.equal(turns[0].answer, "README 已更新。");
  assert.ok(!turns.some((t) => t.question.includes("被打断")));
});

test("only-tool-result:开头兜底轮 + 后续真实提问", () => {
  const turns = parseTurns(fx("only-tool-result.jsonl"));
  assert.equal(turns.length, 2);
  assert.equal(turns[0].question, "（会话开头的输出）");
  assert.equal(turns[0].answer, "开头先出现的是工具结果,我直接继续上一轮的分析。");
  assert.equal(turns[1].question, "真正的问题:接下来做什么?");
  assert.equal(turns[1].answer, "下一步:跑完整回归。");
});

test("system-reminder:注入内容被清理", () => {
  const turns = parseTurns(fx("system-reminder.jsonl"));
  assert.equal(turns.length, 1);
  assert.ok(!turns[0].question.includes("system-reminder"));
  assert.ok(!turns[0].question.includes("应当被清理"));
  assert.ok(turns[0].question.includes("用户真正输入的问题"));
});

test("no-initial-question:开头无提问的输出归入兜底轮", () => {
  const turns = parseTurns(fx("no-initial-question.jsonl"));
  assert.equal(turns.length, 2);
  assert.equal(turns[0].question, "（会话开头的输出）");
  assert.equal(turns[1].question, "好,那么继续第二件事");
});

test("streaming-dup:同 id 流式重复落盘以最新正文为准,usage 只计一次", () => {
  const turns = parseTurns(fx("streaming-dup.jsonl"));
  assert.equal(turns.length, 1);
  const t = turns[0];
  assert.equal(t.answer, "测试全部通过,共 3 项。");
  // usage 只计首次:重复记录的 888/999 不计入
  assert.equal(t.input, 100);
  assert.equal(t.output, 50);
});

test("isMeta:斜杠命令/技能展开的注入记录不算提问", () => {
  const turns = parseTurns(fx("unit/is-meta.jsonl"));
  assert.equal(turns.length, 1);
  assert.equal(turns[0].question, "编译一份exe");
  assert.equal(turns[0].answer, "好的,开始梳理。");
});

test("turnsStats:label 与 whole_session", () => {
  const turns = parseTurns(fx("no-initial-question.jsonl"));
  assert.equal(turnsStats(turns.slice(-1)).label, "本轮");
  assert.equal(turnsStats(turns).label, "最近2轮合计");
  assert.equal(turnsStats(turns, true).label, "整个会话");
});

test("cleanUserText:不改变普通文本", () => {
  assert.equal(cleanUserText("  你好  "), "你好");
});

// ---- Python 对照(存在期望文件时启用) ----
const pyExpected = fs.existsSync(expectedFile)
  ? JSON.parse(fs.readFileSync(expectedFile, "utf8"))
  : null;

if (!pyExpected) {
  test("python 对照期望文件缺失时跳过", () => {
    assert.ok(true, "运行 `py -3 tools/export_expected.py` 生成 test/expected/python-parse.json");
  });
} else {
  for (const [fixture, exp] of Object.entries(pyExpected)) {
    test(`python 对照: ${fixture}`, () => {
      const turns = parseTurns(fx(fixture));
      assert.equal(turns.length, exp.turns.length, "轮数不一致");
      turns.forEach((t, i) => {
        const e = exp.turns[i];
        assert.equal(t.question, e.question, `turn[${i}].question`);
        // 回答语义已改为"最后一段文字"(Python 版是全量拼接,且同 id 重复记录会丢正文):
        // Node 答案应为 Python 答案的尾段/全文;流式重复落盘的 fixture 属于有意分歧,跳过
        if (!fixture.startsWith("streaming-dup")) {
          assert.ok(
            e.answer === t.answer || e.answer.endsWith(t.answer),
            `turn[${i}].answer 应为 Python 答案的最后一段`
          );
        }
        // streaming-dup 的重复记录时间戳在 Python 里被跳过,end 与耗时存在有意分歧
        const isDup = fixture.startsWith("streaming-dup");
        if (!isDup) {
          assert.equal(t.input, e.input, `turn[${i}].input`);
          assert.equal(t.output, e.output, `turn[${i}].output`);
          assert.equal(t.cache_creation, e.cache_creation, `turn[${i}].cache_creation`);
          assert.equal(t.cache_read, e.cache_read, `turn[${i}].cache_read`);
          // 时间戳以秒精度对照(两端都转成秒)
          assert.equal(
            t.start ? Math.floor(t.start.getTime() / 1000) : null,
            e.start ? Math.floor(new Date(e.start).getTime() / 1000) : null,
            `turn[${i}].start`
          );
        }
      });
      const st = turnsStats(turns);
      if (!fixture.startsWith("streaming-dup")) {
        assert.equal(st.duration_sec, exp.stats_whole.duration_sec, "duration_sec");
      }
      assert.equal(st.input, exp.stats_whole.input, "stats.input");
    });
  }
}
