#!/usr/bin/env node
/**
 * Spike(tasks 1.1 / 1.2):验证 @larksuiteoapi/node-sdk WSClient 的两项能力
 *
 *   步骤 1(1.1):收到 im.message.receive_v1
 *     → 运行本脚本后,在飞书里给机器人发一条消息,这里应打印事件
 *   步骤 2(1.2):收到 card.action.trigger 回调,且同步返回 toast 生效
 *     → 先在开放平台「回调配置」添加 card.action.trigger,
 *       再运行 `node spike/spike-ws.js --send-card` 发一张测试卡片,
 *       在飞书里点按钮,观察这里是否打印回调、卡片是否弹 toast
 *
 * 结论写入 design.md D3(支持 → 单 SDK;不支持 → HTTP 回调降级)。
 *
 * 运行:
 *   node spike/spike-ws.js              # 只起长连接收事件
 *   node spike/spike-ws.js --send-card  # 先发一张带 callback 按钮的测试卡片
 *
 * 凭证:读 ~/.claude/feishu.env 的 FEISHU_APP_ID / FEISHU_APP_SECRET /
 *       FEISHU_RECEIVE_ID_TYPE / FEISHU_RECEIVE_ID(secret 不打印到日志)。
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const lark = require("@larksuiteoapi/node-sdk");

function loadFeishuEnv() {
  const p = path.join(os.homedir(), ".claude", "feishu.env");
  const env = {};
  if (!fs.existsSync(p)) {
    console.error(`找不到 ${p},请确认凭证文件存在`);
    process.exit(1);
  }
  for (const raw of fs.readFileSync(p, "utf8").split("\n")) {
    const ln = raw.trim();
    if (!ln || ln.startsWith("#") || !ln.includes("=")) continue;
    const key = ln.split("=")[0].trim().replace(/^export\s+/, "");
    const val = ln.slice(ln.indexOf("=") + 1).trim();
    if (key) env[key] = val;
  }
  // 真实环境变量优先(与运行时 config.js 同一约定)
  return { ...env, ...process.env };
}

async function sendTestCard(env) {
  const API = "https://open.feishu.cn/open-apis";
  const tokenResp = await fetch(`${API}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET }),
  }).then((r) => r.json());
  if (!tokenResp.tenant_access_token) {
    console.error("换取 tenant_access_token 失败:", JSON.stringify(tokenResp));
    process.exit(1);
  }

  const card = {
    schema: "2.0",
    config: { update_multi: true, width_mode: "fill" },
    header: {
      template: "turquoise",
      title: { tag: "plain_text", content: "🧪 Spike 测试卡片" },
    },
    body: {
      direction: "vertical",
      padding: "12px",
      elements: [
        { tag: "markdown", content: "点击下方按钮,观察 spike 终端是否收到 `card.action.trigger` 回调。" },
        {
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
                  text: { tag: "plain_text", content: "🧪 点我" },
                  type: "primary_filled",
                  size: "medium",
                  width: "fill",
                  behaviors: [{ type: "callback", value: { action: "spike_ping", source: "spike-ws" } }],
                },
              ],
            },
            { tag: "column", width: "weighted", weight: 1, elements: [] },
          ],
        },
      ],
    },
  };

  const idType = env.FEISHU_RECEIVE_ID_TYPE || "chat_id";
  const sendResp = await fetch(`${API}/im/v1/messages?receive_id_type=${idType}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${tokenResp.tenant_access_token}`,
    },
    body: JSON.stringify({
      receive_id: env.FEISHU_RECEIVE_ID,
      msg_type: "interactive",
      content: JSON.stringify(card),
    }),
  }).then((r) => r.json());

  if (sendResp.code !== 0) {
    console.error("发送测试卡片失败:", JSON.stringify(sendResp));
    process.exit(1);
  }
  console.log("✅ 测试卡片已发送,请在飞书里点击「🧪 点我」按钮");
}

function main() {
  const env = loadFeishuEnv();
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) {
    console.error("feishu.env 中缺少 FEISHU_APP_ID / FEISHU_APP_SECRET");
    process.exit(1);
  }
  console.log(`使用 App ID: ${env.FEISHU_APP_ID.slice(0, 8)}…(secret 不显示)`);
  console.log("等待长连接建立…\n");

  const dispatcher = new lark.EventDispatcher({}).register({
    "im.message.receive_v1": async (data) => {
      console.log("\n========== [1.1] im.message.receive_v1 ==========");
      console.log("原始事件 payload:");
      console.log(JSON.stringify(data, (k, v) => (v instanceof Buffer ? "<buffer>" : v), 2));
      console.log("=================================================\n");
      return {};
    },

    "card.action.trigger": async (data) => {
      console.log("\n========== [1.2] card.action.trigger ==========");
      console.log("原始回调 payload:");
      console.log(JSON.stringify(data, (k, v) => (v instanceof Buffer ? "<buffer>" : v), 2));
      console.log("尝试同步返回 toast(若飞书弹出 toast 即为支持)…");
      console.log("================================================\n");
      // 同步返回 toast —— 若生效,飞书端会弹出「spike 收到回调」
      return {
        toast: { type: "success", content: "spike 收到回调 ✅" },
      };
    },
  });

  const ws = new lark.WSClient({
    appId: env.FEISHU_APP_ID,
    appSecret: env.FEISHU_APP_SECRET,
    loggerLevel: lark.logLevels ? lark.logLevels.info : undefined,
  });

  if (process.argv.includes("--send-card")) {
    // 先发卡片再起长连接,给用户留出点按钮的时间窗口
    sendTestCard(env)
      .catch((e) => {
        console.error("发送测试卡片异常:", e);
        process.exit(1);
      })
      .finally(() => ws.start({ eventDispatcher: dispatcher }));
  } else {
    ws.start({ eventDispatcher: dispatcher });
  }
}

main();
