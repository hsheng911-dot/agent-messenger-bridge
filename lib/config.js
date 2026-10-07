"use strict";
/**
 * 配置读取(design D2):
 *   - 文件:`~/.claude/feishu-card.json`
 *   - 优先级:环境变量 > JSON > 内置默认
 *   - FEISHU_* 环境变量与 JSON 字段一一映射,便于临时覆盖
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CONFIG_FILE = () => path.join(os.homedir(), ".claude", "feishu-card.json");

// 环境变量名 -> 配置字段
const ENV_MAP = {
  FEISHU_MODE: "mode",
  FEISHU_WEBHOOK: "webhook",
  FEISHU_BTN_LINK: "btn_link",
  FEISHU_APP_ID: "app_id",
  FEISHU_APP_SECRET: "app_secret",
  FEISHU_RECEIVE_ID_TYPE: "receive_id_type",
  FEISHU_RECEIVE_ID: "receive_id",
};

// 数字型字段单独处理
const NUM_FIELDS = {
  FEISHU_DEBOUNCE_SEC: "debounce_sec",
  FEISHU_TURNS: "turns",
  FEISHU_MAX_CHARS: "max_chars",
};

const DEFAULTS = {
  mode: "webhook",
  receive_id_type: "chat_id",
  debounce_sec: 45,
  turns: 1,
  max_chars: 1200,
  btn_link: "",
};

function readJsonFile(filePath) {
  if (!filePath) return {};
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" ? obj : {};
  } catch {
    // 文件不存在或解析失败都按空配置处理,由 validate 报具体问题
    return {};
  }
}

function toInt(v, fallback) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * 加载并校验配置。
 * @param {object} [opts] 注入点,测试用
 * @param {string} [opts.configPath] 配置文件路径(默认 ~/.claude/feishu-card.json)
 * @param {object} [opts.env] 环境变量(默认 process.env)
 * @returns {object} 合并后的完整配置
 * @throws {Error} 模式必填字段缺失时抛错
 */
function loadConfig({ configPath, env } = {}) {
  const environment = env || process.env;
  const fileCfg = readJsonFile(configPath === undefined ? CONFIG_FILE() : configPath);

  const cfg = { ...DEFAULTS, ...fileCfg };

  for (const [envKey, field] of Object.entries(ENV_MAP)) {
    if (environment[envKey]) cfg[field] = environment[envKey];
  }
  for (const [envKey, field] of Object.entries(NUM_FIELDS)) {
    if (environment[envKey] !== undefined && environment[envKey] !== "") {
      cfg[field] = toInt(environment[envKey], cfg[field]);
    }
  }

  cfg.mode = String(cfg.mode || "webhook").trim().toLowerCase();
  cfg.debounce_sec = toInt(cfg.debounce_sec, 45);
  cfg.turns = toInt(cfg.turns, 1);
  cfg.max_chars = toInt(cfg.max_chars, 1200);
  return cfg;
}

/**
 * 校验配置完整性。
 * @throws {Error} 缺少模式必填字段时抛错,错误信息给出缺失字段与修复提示
 */
function validateConfig(cfg) {
  const missing = [];
  if (cfg.mode === "webhook") {
    if (!cfg.webhook) missing.push("webhook(群机器人 Webhook 地址)");
  } else if (cfg.mode === "app") {
    if (!cfg.app_id) missing.push("app_id");
    if (!cfg.app_secret) missing.push("app_secret");
    if (!cfg.receive_id) missing.push("receive_id");
  } else {
    throw new Error(`未知模式 "${cfg.mode}",应为 webhook 或 app`);
  }
  if (missing.length) {
    throw new Error(`配置不完整(mode=${cfg.mode}),缺少: ${missing.join(", ")}`);
  }
  return cfg;
}

module.exports = { loadConfig, validateConfig, CONFIG_FILE, DEFAULTS };
