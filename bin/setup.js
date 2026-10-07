#!/usr/bin/env node
"use strict";
/**
 * agent-messenger-bridge 安装向导(替代 install.sh)。
 *
 * 分步:运行时探测 → 旧配置导入提示 → 模式选择 → 凭证现场验证
 *       → [app] 拉群列表选接收者 → 选项 → 写配置 → 合并 settings.json
 *       → [app] 装依赖 + 拉起 bridge + 测试卡片
 *
 * 运行:node bin/setup.js(零依赖即可进向导;SDK 仅 app 模式需要)
 */

const { execFile, spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline/promises");
const { loadConfig } = require("../lib/config");
const { createFeishuClient } = require("../lib/feishu");

const HOME = os.homedir();
const CONFIG_PATH = path.join(HOME, ".claude", "feishu-card.json");
const ENV_FILE = path.join(HOME, ".claude", "feishu.env");
const SETTINGS_PATH = path.join(HOME, ".claude", "settings.json");
const PKG_ROOT = path.resolve(__dirname, "..");
const NOTIFY_JS = path.join(PKG_ROOT, "lib", "notify-card.js");
const BRIDGE_JS = path.join(PKG_ROOT, "lib", "bridge.js");

// --------------------------------------------------------------------------- //
function sh(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: opts.timeout || 10_000, windowsHide: true, ...opts }, (err, stdout, stderr) =>
      resolve({ ok: !err, stdout: String(stdout || ""), stderr: String(stderr || ""), err })
    );
  });
}

async function ask(rl, question, fallback = "") {
  const suffix = fallback !== "" ? ` [默认 ${fallback}]` : "";
  const raw = (await rl.question(question + suffix)).trim();
  return raw || fallback;
}

function log(msg) {
  console.log(msg);
}

// --------------------------------------------------------------------------- //
// 第 1 步:运行时探测
// --------------------------------------------------------------------------- //
async function detectRuntime() {
  const nodeOk = parseInt(process.versions.node, 10) >= 18;
  log(`\n[1/6] 运行时探测`);
  log(`  node ${process.versions.node} ${nodeOk ? "✅" : "❌ 需要 >= 18"}`);
  if (!nodeOk) {
    log("  请升级 Node.js 后重试:https://nodejs.org");
    process.exit(1);
  }
  const tmux = await sh("tmux", ["-V"]);
  log(`  tmux  ${tmux.ok ? `✅ ${tmux.stdout.trim()}` : "⚠️  未安装(按钮指令将走 claude -p 兜底,不影响安装)"}`);
  const claude = resolveClaudePath();
  log(`  claude ${claude ? `✅ ${claude}` : "⚠️  未找到(claude -p 兜底不可用,指令会进队列)"}`);
  return { nodeOk, tmux: tmux.ok, claude: !!claude };
}

function resolveClaudePath() {
  const candidates = ["claude", "claude.exe", "claude.cmd"];
  const exts = String(process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";");
  for (const dir of String(process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    for (const name of candidates) {
      for (const ext of ["", ...exts.map((e) => e.toLowerCase())]) {
        const full = path.join(dir, name + ext);
        try {
          fs.accessSync(full, fs.constants.X_OK);
          return full;
        } catch {
          // 继续找
        }
      }
    }
  }
  return "";
}

// --------------------------------------------------------------------------- //
// 第 2 步:旧配置导入提示(一次性)
// --------------------------------------------------------------------------- //
function readOldEnv() {
  if (!fs.existsSync(ENV_FILE)) return null;
  const map = {};
  for (const raw of fs.readFileSync(ENV_FILE, "utf8").split("\n")) {
    const ln = raw.trim();
    if (!ln || ln.startsWith("#") || !ln.includes("=")) continue;
    const key = ln.split("=")[0].trim().replace(/^export\s+/, "");
    const val = ln.slice(ln.indexOf("=") + 1).trim();
    if (key) map[key] = val;
  }
  return map;
}

function mapOldEnv(oldEnv) {
  if (!oldEnv) return {};
  // 0 是合法值(去抖 0=每轮都发、轮数 0=整个会话),不能用 `|| 默认` 兜底
  const toInt = (v, dflt) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : dflt;
  };
  const out = {};
  if (oldEnv.FEISHU_MODE) out.mode = oldEnv.FEISHU_MODE;
  if (oldEnv.FEISHU_WEBHOOK) out.webhook = oldEnv.FEISHU_WEBHOOK;
  if (oldEnv.FEISHU_BTN_LINK) out.btn_link = oldEnv.FEISHU_BTN_LINK;
  if (oldEnv.FEISHU_APP_ID) out.app_id = oldEnv.FEISHU_APP_ID;
  if (oldEnv.FEISHU_APP_SECRET) out.app_secret = oldEnv.FEISHU_APP_SECRET;
  if (oldEnv.FEISHU_RECEIVE_ID_TYPE) out.receive_id_type = oldEnv.FEISHU_RECEIVE_ID_TYPE;
  if (oldEnv.FEISHU_RECEIVE_ID) out.receive_id = oldEnv.FEISHU_RECEIVE_ID;
  if (oldEnv.FEISHU_DEBOUNCE_SEC) out.debounce_sec = toInt(oldEnv.FEISHU_DEBOUNCE_SEC, 45);
  if (oldEnv.FEISHU_TURNS) out.turns = toInt(oldEnv.FEISHU_TURNS, 1);
  if (oldEnv.FEISHU_MAX_CHARS) out.max_chars = toInt(oldEnv.FEISHU_MAX_CHARS, 1200);
  return out;
}

// --------------------------------------------------------------------------- //
// 第 3-4 步:模式选择 + 凭证验证
// --------------------------------------------------------------------------- //
async function chooseMode(rl) {
  log("\n[2/6] 选择模式:");
  log("  1) webhook  群自定义机器人     —— 5 分钟搞定,但【按钮点击无回调】");
  log("  2) app      企业自建应用机器人 —— 支持真·交互按钮(继续/自查/提交/结束)");
  const choice = await ask(rl, "选择模式 [1/2,默认 2]: ", "2");
  return choice === "1" ? "webhook" : "app";
}

async function verifyWebhook(rl, client) {
  for (;;) {
    const webhook = (await rl.question("粘贴群机器人 Webhook 地址: ")).trim();
    if (!webhook) {
      log("❌ Webhook 不能为空,重试。");
      continue;
    }
    log("  发送测试消息验证…");
    const r = await client.sendWebhook(webhook, {
      schema: "2.0",
      header: { template: "blue", title: { tag: "plain_text", content: "✅ agent-messenger-bridge 测试消息" } },
      body: { direction: "vertical", padding: "12px", elements: [{ tag: "markdown", content: "向导验证消息,收到即凭证有效。" }] },
    });
    if (r.code === 0 || r.StatusCode === 0) {
      log("  ✅ 测试消息已发出,请在群里确认");
      return webhook;
    }
    log(`  ❌ 飞书返回异常: ${JSON.stringify(r)}\n  请重试(粘贴新地址)或 Ctrl+C 退出。`);
  }
}

/**
 * app 凭证收集与现场验证。凭证来源菜单:
 *   1) 沿用现有配置(检测到旧 feishu.env 凭证时显示,回车默认)
 *   2) 手动输入 App ID / Secret
 *   3) 没有应用 → 显示新建指引
 * 返回 { app_id, app_secret }(验证通过后)。
 */
function openBrowser(url) {
  const opener =
    process.platform === "win32"
      ? spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" })
      : spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { detached: true, stdio: "ignore" });
  opener.unref();
}

function printCreateGuide() {
  try {
    openBrowser("https://open.feishu.cn/app");
    log("  已在浏览器打开开发者后台(若没弹出,手动访问 https://open.feishu.cn/app)");
  } catch {
    log("  请手动打开 https://open.feishu.cn/app");
  }
  log("  新建企业自建应用(约 5 分钟):");
  log("    1. 创建企业自建应用");
  log("    2. 添加应用能力 → 机器人");
  log("    3. 「凭证与基础信息」页复制 App ID / App Secret");
  log("  (创建完成后回到这里手输或粘贴)");
}

async function collectAppCredentials(rl, imported = {}) {
  for (;;) {
    const appId =
      (await rl.question(`App ID (cli_xxx)${imported.app_id ? " [回车沿用旧值]" : ""}: `)).trim() ||
      imported.app_id ||
      "";
    const secretHint = imported.app_secret ? " [回车沿用旧值]" : "";
    const appSecret =
      (await rl.question(`App Secret${secretHint}: `)).trim() || imported.app_secret || "";
    if (!appId || !appSecret) {
      log("❌ App ID / Secret 不能为空,重试。");
      continue;
    }
    return { app_id: appId, app_secret: appSecret };
  }
}

async function verifyApp(rl, client, imported = {}) {
  const hasImported = Boolean(imported.app_id && imported.app_secret);
  const options = [];
  if (hasImported) {
    options.push({ key: "reuse", label: `沿用现有配置凭证(App ID: ${imported.app_id.slice(0, 8)}…)` });
  }
  options.push({ key: "manual", label: "手动输入 App ID / Secret" });
  options.push({ key: "create", label: "没有应用,先看新建指引" });

  for (;;) {
    log("  App 凭证来源:");
    options.forEach((o, i) => log(`    ${i + 1}) ${o.label}`));
    const pick = parseInt(await ask(rl, `选择 [默认 ${hasImported ? 1 : 2}]: `, hasImported ? "1" : "2"), 10);
    const opt = options[pick - 1];
    if (!opt) {
      log("❌ 无效选择,重试。");
      continue;
    }
    if (opt.key === "create") {
      printCreateGuide();
      continue;
    }
    const creds = opt.key === "reuse" ? { app_id: imported.app_id, app_secret: imported.app_secret } : await collectAppCredentials(rl, imported);

    log("  验证凭证(换取 tenant_access_token)…");
    try {
      const token = await client.getTenantToken(creds.app_id, creds.app_secret);
      if (token) {
        log("  ✅ 凭证有效");
        return creds;
      }
    } catch (e) {
      log(`  ❌ ${e.message}\n  回到来源菜单重试。`);
    }
  }
}

// --------------------------------------------------------------------------- //
// 第 5 步(app):群列表选择接收者
// --------------------------------------------------------------------------- //
/**
 * app 模式选择接收者。来源菜单:
 *   1) 沿用现有配置(检测到旧 feishu.env 的接收者时显示,回车默认)
 *   2) 从机器人所在群列表选择(im/v1/chats 只列群;机器人只有单聊时列表为空,属正常)
 *   3) 手动输入 chat_id / open_id
 */
async function chooseReceiver(rl, client, token, imported = {}) {
  let items = [];
  try {
    log("\n拉取机器人所在群列表…");
    const resp = await client.listChats({ token, pageSize: 20 });
    if (!resp || resp.code !== 0) throw new Error(JSON.stringify(resp));
    items = resp?.data?.items || [];
    if (!items.length) {
      log("  (机器人没有加入任何群——只用单聊时这是正常的,选「沿用现有配置」或手动输入)");
    }
  } catch (e) {
    log(`  ⚠️ 拉取群列表失败(${e.message}),可改用其他方式。`);
  }

  const options = [];
  if (imported.receive_id) {
    const t = imported.receive_id_type || "chat_id";
    options.push({ key: "reuse", label: `沿用现有配置(${t}: ${imported.receive_id})` });
  }
  if (items.length) {
    options.push({ key: "list", label: `从群列表中选择(${items.length} 个群)` });
  }
  options.push({ key: "manual", label: "手动输入 chat_id / open_id" });

  for (;;) {
    log("  接收者来源:");
    options.forEach((o, i) => log(`    ${i + 1}) ${o.label}`));
    const defaultPick = options[0].key === "reuse" ? "1" : options[0].key === "list" ? "2" : "1";
    const pick = parseInt(await ask(rl, "选择: ", defaultPick), 10);
    const opt = options[pick - 1];
    if (!opt) {
      log("❌ 无效选择,重试。");
      continue;
    }

    if (opt.key === "reuse") {
      return { receiveIdType: imported.receive_id_type || "chat_id", receiveId: imported.receive_id };
    }

    if (opt.key === "list") {
      items.forEach((c, i) => log(`   ${i + 1}) ${c.name}  (${c.chat_id})`));
      const s = (await ask(rl, "输入序号选择,或直接粘贴 chat_id: ", "1")).trim();
      const idx = parseInt(s, 10);
      if (Number.isFinite(idx) && items[idx - 1]) {
        return { receiveIdType: "chat_id", receiveId: items[idx - 1].chat_id };
      }
      if (s) {
        return { receiveIdType: s.startsWith("oc_") ? "chat_id" : "open_id", receiveId: s };
      }
      continue;
    }

    // manual
    const idType = await ask(rl, "接收者类型 [chat_id=群聊 / open_id=单聊]", "chat_id");
    const receiveId = (await rl.question("接收者 ID (oc_xxx / ou_xxx): ")).trim();
    if (!receiveId) {
      log("❌ 接收者 ID 不能为空,重试。");
      continue;
    }
    return { receiveIdType: idType, receiveId };
  }
}

// --------------------------------------------------------------------------- //
// 第 6 步:配置与 hook 写入
// --------------------------------------------------------------------------- //
function writeConfig(cfg) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  try {
    fs.chmodSync(CONFIG_PATH, 0o600);
  } catch {
    // Windows FAT 等场景无 POSIX 权限,忽略
  }
}

/**
 * 合并 Stop hook 进 settings.json。settingsPath/notifyJs 可注入(测试);
 * 既有本工具 hook(新旧标识 notify-card.js / notify_card.py)替换而非追加。
 */
function mergeSettingsJson(settingsPath = SETTINGS_PATH, notifyJs = NOTIFY_JS) {
  let settings = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  } catch {
    settings = {};
  }
  if (fs.existsSync(settingsPath)) {
    fs.writeFileSync(`${settingsPath}.bak.${Date.now()}`, fs.readFileSync(settingsPath));
  }
  settings.hooks = settings.hooks || {};
  settings.hooks.Stop = settings.hooks.Stop || [];

  const hookCmd = `node ${JSON.stringify(notifyJs)}`;
  let replaced = false;
  for (const group of settings.hooks.Stop) {
    for (const h of group?.hooks || []) {
      const cmd = String(h.command || "");
      if (cmd.includes("notify-card.js") || cmd.includes("notify_card.py")) {
        h.command = hookCmd;
        h.async = true;
        h.timeout = 20;
        replaced = true;
      }
    }
  }
  if (!replaced) {
    settings.hooks.Stop.push({
      hooks: [{ type: "command", command: hookCmd, async: true, timeout: 20 }],
    });
  }
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  return { replaced, backup: true };
}

// --------------------------------------------------------------------------- //
// app 模式收尾:装依赖 + 起 bridge + 测试卡片
// --------------------------------------------------------------------------- //
async function installSdkAndStartBridge(cfg) {
  log("\n安装桥接依赖(@larksuiteoapi/node-sdk)…");
  const npmcli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  const install = await sh(process.execPath, [npmcli, "install", "--save", "@larksuiteoapi/node-sdk"], {
    timeout: 300_000,
  });
  if (!install.ok) {
    log("  ⚠️ SDK 安装失败,可稍后在包目录手动执行 npm install");
  } else {
    log("  ✅ 依赖安装完成");
  }

  log("后台启动桥接服务…");
  const stateDir = path.join(HOME, ".claude", "feishu-bridge");
  fs.mkdirSync(stateDir, { recursive: true });
  const out = fs.openSync(path.join(stateDir, "bridge.log"), "a");
  const child = spawn(process.execPath, [BRIDGE_JS], { detached: true, stdio: ["ignore", out, out] });
  child.unref();
  log(`  ✅ bridge 已启动(pid ${child.pid}),日志: ${stateDir}/bridge.log`);
}

async function sendTestCardApp(cfg, client) {
  try {
    const token = await client.getTenantToken(cfg.app_id, cfg.app_secret);
    const card = {
      schema: "2.0",
      header: { template: "turquoise", title: { tag: "plain_text", content: "✅ agent-messenger-bridge 安装成功" } },
      body: { direction: "vertical", padding: "12px", elements: [{ tag: "markdown", content: "桥接服务已启动,之后每轮任务结束都会推卡片。" }] },
    };
    const r = await client.sendMessage({
      token,
      receiveIdType: cfg.receive_id_type,
      receiveId: cfg.receive_id,
      msgType: "interactive",
      content: JSON.stringify(card),
    });
    if (r.code === 0) log("  ✅ 测试卡片已发送,请在飞书确认");
    else log(`  ⚠️ 测试卡片发送失败: ${JSON.stringify(r)}`);
  } catch (e) {
    log(`  ⚠️ 测试卡片发送异常: ${e.message}`);
  }
}

// --------------------------------------------------------------------------- //
async function main() {
  if (!process.stdin.isTTY) {
    log("本向导需要交互式终端(TTY)。");
    log("非交互安装请参考 README 的「手动配置」一节。");
    return 1;
  }

  log("==========================================");
  log(" agent-messenger-bridge  安装向导");
  log("==========================================");

  await detectRuntime();

  // 旧配置导入提示(一次性)
  const oldEnv = readOldEnv();
  const imported = mapOldEnv(oldEnv);
  if (oldEnv) {
    log(`\n检测到旧版配置 ${ENV_FILE},将预填到新配置(字段映射:FEISHU_* → JSON)。`);
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const client = createFeishuClient({});

  const mode = await chooseMode(rl);
  const cfg = { ...imported, mode };

  if (mode === "webhook") {
    cfg.webhook = await verifyWebhook(rl, client);
  } else {
    ({ app_id: cfg.app_id, app_secret: cfg.app_secret } = await verifyApp(rl, client, imported));
    const token = await client.getTenantToken(cfg.app_id, cfg.app_secret);
    const recv = await chooseReceiver(rl, client, token, imported);
    cfg.receive_id_type = recv.receiveIdType;
    cfg.receive_id = recv.receiveId;
  }

  log("\n[3/6] 选项(直接回车取默认):");
  cfg.debounce_sec = parseInt(await ask(rl, "同一会话去抖秒数 [默认 45,0=每轮都发]: ", String(cfg.debounce_sec ?? 45)), 10);
  cfg.turns = parseInt(
    await ask(rl, "卡片展示轮数(1=最近一轮,0=整个会话): ", String(cfg.turns ?? 1)),
    10
  );

  log("\n[4/6] 写入配置…");
  writeConfig(cfg);
  log(`  ✅ ${CONFIG_PATH}`);

  log("[5/6] 合并 Stop hook 到 settings.json…");
  const { replaced } = mergeSettingsJson();
  log(`  ✅ ${SETTINGS_PATH}(${replaced ? "已替换既有本工具 hook" : "新增 hook"})`);

  if (mode === "app") {
    log("[6/6] 桥接服务(app 模式专属)…");
    await installSdkAndStartBridge(cfg);
    await sendTestCardApp(cfg, client);
    const appBase = `https://open.feishu.cn/app/${cfg.app_id}`;
    log("\n飞书开放平台还需确认(已配置过可忽略):");
    log(`  1) 应用能力开启「机器人」  ${appBase}`);
    log(`  2) 权限:im:message、im:message.p2p_msg:readonly、im:message.group_at_msg:readonly  ${appBase}/auth`);
    log(`  3) 事件配置:长连接 + 添加事件「接收消息 im.message.receive_v1」  ${appBase}/event`);
    log(`  4) 回调配置:添加「卡片回传交互 card.action.trigger」  ${appBase}/event`);
    log(`  5) 创建版本并【发布】—— 不发布不生效  ${appBase}/release`);
    log("\n发布后,在飞书里对机器人发 /list 即可查询所有 Claude Code 会话。");
  } else {
    log("[6/6] webhook 模式无需桥接服务。");
    log("\n测试:在 Claude Code 里随便问一句,飞书应收到卡片。");
  }

  rl.close();
  return 0;
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(`向导异常: ${e.message}`);
      process.exit(1);
    }
  );
}

module.exports = { main, mapOldEnv, mergeSettingsJson, writeConfig, CONFIG_PATH, PKG_ROOT };
