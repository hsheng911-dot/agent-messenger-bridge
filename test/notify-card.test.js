"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  buildCard,
  debounced,
  readHookInput,
  fmtTokens,
  fmtDuration,
  truncate,
  splitQuestionImages,
  uploadQuestionImages,
} = require("../lib/notify-card");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "amb-notify-"));

const baseCtx = {
  session_id: "abcdef1234567890",
  project: "demo",
  branch: "main",
  git_status: "工作区干净",
  time: "2026-10-04 10:00:00",
  summary: "全部通过",
  turns: [["跑一下测试", "🔧 调用 `Bash` npm test … 全部通过"]],
  stats: { duration_sec: 312, input: 860_000, output: 3200, cache_creation: 1000, cache_read: 700_000, label: "本轮" },
};

function findButtons(card) {
  const out = [];
  for (const e of card.body.elements) {
    if (e.tag === "column_set") {
      for (const col of e.columns) {
        for (const el of col.elements) {
          if (el.tag === "button") out.push(el);
        }
      }
    }
  }
  return out;
}

test("buildCard:app 模式四个回传按钮 + list", () => {
  const card = buildCard(baseCtx, "app");
  const btns = findButtons(card);
  const byText = Object.fromEntries(btns.map((b) => [b.text.content, b]));
  assert.deepEqual(byText["▶ 继续"].behaviors[0], {
    type: "callback",
    value: { action: "continue", session_id: "abcdef1234567890" },
  });
  assert.equal(byText["✅ 结束"].type, "danger");
  assert.equal(byText["🧭 全部会话"].behaviors[0].value.action, "list");
  assert.equal(card.header.title.content, "✅ Claude Code 任务完成");
});

test("buildCard:webhook 模式无 callback,配链接时降级 open_url", () => {
  const noLink = buildCard(baseCtx, "webhook", {});
  assert.ok(findButtons(noLink).every((b) => !b.behaviors));
  assert.ok(
    noLink.body.elements.some(
      (e) => e.tag === "markdown" && e.content.includes("不会产生回调")
    )
  );

  const withLink = buildCard(baseCtx, "webhook", { btn_link: "https://example.com/ci" });
  const btns = findButtons(withLink);
  assert.ok(btns.length > 0);
  assert.deepEqual(btns[0].behaviors, [
    { type: "open_url", default_url: "https://example.com/ci" },
  ]);
});

test("buildCard:``` 替换为 ''' 且超长截断", () => {
  const ctx = {
    ...baseCtx,
    turns: [["问", "回答里带 ```代码块``` 标记"]],
  };
  const card = buildCard(ctx, "app");
  const md = card.body.elements.filter((e) => e.tag === "markdown").map((e) => e.content);
  assert.ok(md.some((c) => c.includes("'''") && !c.includes("```代码块")));
});

test("buildCard:超长输出截断到 max_chars", () => {
  const long = "x".repeat(3000);
  const card = buildCard({ ...baseCtx, turns: [["问", long]] }, "app", { max_chars: 1200 });
  const joined = card.body.elements.map((e) => e.content || "").join("\n");
  assert.ok(joined.includes("…(已截断)"));
});

test("buildCard:stats 行展示耗时与 token", () => {
  const card = buildCard(baseCtx, "app");
  const joined = card.body.elements.map((e) => e.content || "").join("\n");
  assert.ok(joined.includes("5分12秒"));
  assert.ok(joined.includes("1.6M")); // (860000+1000+700000)/1e6
  assert.ok(joined.includes("3.2k"));
});

test("debounce:窗口内命中,窗口外放行,0 禁用", () => {
  const dir = path.join(tmp, "deb");
  const now = 1_000_000;
  assert.ok(!debounced("sid123456", 45, dir, now)); // 首次放行
  assert.ok(debounced("sid123456", 45, dir, now + 10)); // 窗口内
  assert.ok(!debounced("sid123456", 45, dir, now + 46)); // 窗口外
  assert.ok(!debounced("sid123456", 0, dir, now + 1)); // 禁用
});

test("readHookInput:空/非法输入返回空对象", () => {
  assert.deepEqual(readHookInput(""), {});
  assert.deepEqual(readHookInput("not json"), {});
  assert.deepEqual(readHookInput("[1,2]"), {});
  assert.deepEqual(readHookInput('{"session_id":"s1"}'), { session_id: "s1" });
});

test("splitQuestionImages:拆出图片标记与文字", () => {
  const q = "[Image: source: C:\\tmp\\a.png]\n看看这张图,顺便跑下测试";
  const { clean, paths } = splitQuestionImages(q);
  assert.deepEqual(paths, ["C:\\tmp\\a.png"]);
  assert.ok(!clean.includes("Image:"));
  assert.ok(clean.includes("看看这张图"));
  // 多张图
  const two = splitQuestionImages("[Image: source: a.png][Image: source: b.png] 文字");
  assert.deepEqual(two.paths, ["a.png", "b.png"]);
  // 无图
  assert.deepEqual(splitQuestionImages("纯文字提问").paths, []);
});

test("buildCard:questionImages 时以 img 元素展示图片", () => {
  const ctx = {
    ...baseCtx,
    turns: [["[Image: source: C:\\tmp\\a.png] 看看这张图", "结论如下"]],
  };
  const images = new Map([[0, [{ path: "C:\\tmp\\a.png", img_key: "img_v2_x" }]]]);
  const card = buildCard(ctx, "app", { questionImages: images });
  const img = card.body.elements.find((e) => e.tag === "img");
  assert.ok(img, "应存在 img 元素");
  assert.equal(img.img_key, "img_v2_x");
  const joined = card.body.elements.map((e) => e.content || "").join("\n");
  assert.ok(joined.includes("看看这张图"));
  assert.ok(!joined.includes("Image: source:")); // 标记不再以文字出现
});

test("buildCard:上传失败的图片降级为文字说明", () => {
  const ctx = {
    ...baseCtx,
    turns: [["[Image: source: C:\\tmp\\gone.png] 看图", "结论"]],
  };
  const card = buildCard(ctx, "app", { questionImages: new Map() });
  const joined = card.body.elements.map((e) => e.content || "").join("\n");
  assert.ok(!card.body.elements.some((e) => e.tag === "img"));
  assert.ok(joined.includes("C:\\tmp\\gone.png")); // 原图路径作为降级说明保留
});

test("uploadQuestionImages:只上传存在且未超限的图片", async () => {
  const small = path.join(tmp, "small.png");
  fs.writeFileSync(small, "png");
  const uploads = [];
  const client = {
    uploadImage: async ({ filePath }) => {
      uploads.push(filePath);
      return `img_key_${uploads.length}`;
    },
  };
  const ok = await uploadQuestionImages([small, path.join(tmp, "nope-missing.png")], client, "tk");
  assert.equal(uploads.length, 1);
  assert.deepEqual(ok, [{ path: small, img_key: "img_key_1" }]);
});

test("fmt 助手", () => {
  assert.equal(fmtTokens(1_234_567), "1.2M");
  assert.equal(fmtTokens(12_345), "12.3k");
  assert.equal(fmtTokens(999), "999");
  assert.equal(fmtDuration(452), "7分32秒");
  assert.equal(fmtDuration(4500), "1小时15分");
  assert.equal(fmtDuration(30), "30秒");
  assert.equal(truncate("abc", 2), "ab\n…(已截断)");
  assert.equal(truncate("ab", 2), "ab");
});
