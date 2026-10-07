"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadConfig, validateConfig } = require("../lib/config");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "amb-config-"));
const jsonPath = (obj) => {
  const p = path.join(tmp, `cfg-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(p, JSON.stringify(obj));
  return p;
};

test("默认值:空配置按 webhook 模式处理", () => {
  const cfg = loadConfig({ configPath: path.join(tmp, "not-exist.json"), env: {} });
  assert.equal(cfg.mode, "webhook");
  assert.equal(cfg.debounce_sec, 45);
  assert.equal(cfg.turns, 1);
  assert.equal(cfg.max_chars, 1200);
  assert.equal(cfg.receive_id_type, "chat_id");
});

test("优先级:环境变量 > JSON > 默认", () => {
  const p = jsonPath({ mode: "app", app_id: "cli_from_json", debounce_sec: 10 });
  const cfg = loadConfig({
    configPath: p,
    env: { FEISHU_APP_ID: "cli_from_env", FEISHU_TURNS: "3" },
  });
  assert.equal(cfg.app_id, "cli_from_env"); // env 覆盖 JSON
  assert.equal(cfg.mode, "app"); // JSON 覆盖默认
  assert.equal(cfg.debounce_sec, 10);
  assert.equal(cfg.turns, 3); // 数字字段经 env 转换
});

test("validate:webhook 模式缺 webhook 报错", () => {
  assert.throws(() => validateConfig({ mode: "webhook" }), /webhook/);
});

test("validate:app 模式缺凭证报错并列出缺失字段", () => {
  assert.throws(
    () => validateConfig({ mode: "app", app_id: "cli_x" }),
    (e) => /app_secret/.test(e.message) && /receive_id/.test(e.message)
  );
});

test("validate:未知模式报错", () => {
  assert.throws(() => validateConfig({ mode: "slack" }), /未知模式/);
});

test("validate:完整配置通过并原样返回", () => {
  const cfg = { mode: "app", app_id: "cli_x", app_secret: "s", receive_id: "oc_x" };
  assert.deepEqual(validateConfig(cfg), cfg);
});
