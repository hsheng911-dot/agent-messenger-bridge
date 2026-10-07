"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { mapOldEnv, mergeSettingsJson } = require("../bin/setup.js");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "amb-setup-"));
const NOTIFY_JS = "D:\\fake\\lib\\notify-card.js";

// ---------- mapOldEnv:feishu.env 字段映射 ----------
test("mapOldEnv:FEISHU_* → JSON 字段映射", () => {
  const mapped = mapOldEnv({
    FEISHU_MODE: "app",
    FEISHU_APP_ID: "cli_x",
    FEISHU_APP_SECRET: "sec",
    FEISHU_RECEIVE_ID_TYPE: "chat_id",
    FEISHU_RECEIVE_ID: "oc_1",
    FEISHU_DEBOUNCE_SEC: "30",
    FEISHU_TURNS: "0",
    FEISHU_MAX_CHARS: "800",
    FEISHU_BTN_LINK: "https://x",
    FEISHU_WEBHOOK: "https://hook",
    IGNORED: "nope",
  });
  assert.deepEqual(mapped, {
    mode: "app",
    app_id: "cli_x",
    app_secret: "sec",
    receive_id_type: "chat_id",
    receive_id: "oc_1",
    debounce_sec: 30,
    turns: 0,
    max_chars: 800,
    btn_link: "https://x",
    webhook: "https://hook",
  });
});

test("mapOldEnv:空输入返回空对象", () => {
  assert.deepEqual(mapOldEnv(null), {});
  assert.deepEqual(mapOldEnv({}), {});
});

// ---------- mergeSettingsJson:hook 合并/替换/备份 ----------
test("mergeSettingsJson:全新安装追加 hook,保留其他配置", () => {
  const p = path.join(tmp, "s1.json");
  fs.writeFileSync(p, JSON.stringify({ model: "opus", hooks: { Stop: [{ hooks: [{ type: "command", command: "other-hook" }] }] } }));
  const { replaced } = mergeSettingsJson(p, NOTIFY_JS);
  assert.ok(!replaced);
  const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
  assert.equal(cfg.model, "opus"); // 原有配置保留
  assert.equal(cfg.hooks.Stop.length, 2);
  const ours = cfg.hooks.Stop[1].hooks[0];
  assert.match(ours.command, /notify-card\.js/);
  assert.equal(ours.async, true);
  assert.equal(ours.timeout, 20);
});

test("mergeSettingsJson:重复安装替换不追加", () => {
  const p = path.join(tmp, "s2.json");
  mergeSettingsJson(p, NOTIFY_JS);
  const before = JSON.parse(fs.readFileSync(p, "utf8"));
  mergeSettingsJson(p, NOTIFY_JS);
  const after = JSON.parse(fs.readFileSync(p, "utf8"));
  assert.equal(before.hooks.Stop.length, 1);
  assert.equal(after.hooks.Stop.length, 1);
});

test("mergeSettingsJson:旧 Python hook 被替换(避免双 hook 并存)", () => {
  const p = path.join(tmp, "s3.json");
  fs.writeFileSync(
    p,
    JSON.stringify({
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "bash -c 'source ~/.claude/feishu.env; python3 ~/.claude/notify_card.py'", async: true, timeout: 20 }] }],
      },
    })
  );
  const { replaced } = mergeSettingsJson(p, NOTIFY_JS);
  assert.ok(replaced);
  const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
  assert.equal(cfg.hooks.Stop.length, 1);
  assert.match(cfg.hooks.Stop[0].hooks[0].command, /notify-card\.js/);
  assert.ok(!JSON.stringify(cfg).includes("notify_card.py"));
});

test("mergeSettingsJson:写入前产生备份文件", () => {
  const p = path.join(tmp, "s4.json");
  fs.writeFileSync(p, "{}");
  mergeSettingsJson(p, NOTIFY_JS);
  const dir = fs.readdirSync(tmp);
  assert.ok(dir.some((f) => f.startsWith("s4.json.bak.")));
});

test("mergeSettingsJson:settings.json 不存在时从零创建", () => {
  const p = path.join(tmp, "s5.json");
  const { replaced } = mergeSettingsJson(p, NOTIFY_JS);
  assert.ok(!replaced);
  const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
  assert.equal(cfg.hooks.Stop.length, 1);
});
