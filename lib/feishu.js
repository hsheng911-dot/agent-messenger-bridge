"use strict";
/**
 * 飞书 REST 客户端(纯 fetch,零第三方依赖;design D3 —— 只有 bridge 用 SDK)。
 *   - tenant_access_token 本地缓存,过期前 60 秒内复用
 *   - 发消息 / 群列表 / Webhook 发送
 * fetch 实现可注入,便于单测。
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const API_BASE = "https://open.feishu.cn/open-apis";
const TOKEN_CACHE_DIR = () => path.join(os.homedir(), ".cache", "claude-feishu");
const TOKEN_CACHE_FILE = () => path.join(TOKEN_CACHE_DIR(), "tenant_token.json");

/**
 * @param {object} [opts]
 * @param {Function} [opts.fetchImpl] fetch 实现(默认 globalThis.fetch)
 * @param {string} [opts.apiBase] API 根地址
 * @param {string} [opts.tokenCachePath] token 缓存文件路径(测试注入临时目录)
 */
function createFeishuClient(opts = {}) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const apiBase = opts.apiBase || API_BASE;
  const tokenCachePath = opts.tokenCachePath === undefined ? TOKEN_CACHE_FILE() : opts.tokenCachePath;

  async function postJson(url, payload, headers = {}) {
    const resp = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
      body: JSON.stringify(payload),
    });
    return resp.json();
  }

  /**
   * 获取 tenant_access_token,带本地缓存(过期前 60 秒内复用)。
   * @throws {Error} 换取失败时抛错,信息含飞书返回码
   */
  async function getTenantToken(appId, appSecret) {
    if (tokenCachePath) {
      try {
        const cache = JSON.parse(fs.readFileSync(tokenCachePath, "utf8"));
        if (cache.expire_at > Date.now() / 1000 + 60 && cache.token) {
          return cache.token;
        }
      } catch {
        // 无缓存 / 损坏,走重新获取
      }
    }

    const r = await postJson(`${apiBase}/auth/v3/tenant_access_token/internal`, {
      app_id: appId,
      app_secret: appSecret,
    });
    if (!r.tenant_access_token) {
      throw new Error(`获取 tenant_access_token 失败: ${JSON.stringify(r)}`);
    }
    if (tokenCachePath) {
      try {
        fs.mkdirSync(path.dirname(tokenCachePath), { recursive: true });
        fs.writeFileSync(
          tokenCachePath,
          JSON.stringify({ token: r.tenant_access_token, expire_at: Date.now() / 1000 + (r.expire || 7200) })
        );
      } catch {
        // 缓存写失败不影响主流程
      }
    }
    return r.tenant_access_token;
  }

  /**
   * 以应用身份发消息。
   * @returns {object} 飞书响应(code!==0 时也原样返回,由调用方决定容错策略)
   */
  async function sendMessage({ token, receiveIdType = "chat_id", receiveId, msgType, content }) {
    return postJson(
      `${apiBase}/im/v1/messages?receive_id_type=${encodeURIComponent(receiveIdType)}`,
      { receive_id: receiveId, msg_type: msgType, content },
      { Authorization: `Bearer ${token}` }
    );
  }

  /** 回复指定消息(reply 形式,群聊里以回复出现)。 */
  async function replyMessage({ token, messageId, msgType, content }) {
    return postJson(
      `${apiBase}/im/v1/messages/${encodeURIComponent(messageId)}/reply`,
      { msg_type: msgType, content },
      { Authorization: `Bearer ${token}` }
    );
  }

  /** 拉取机器人所在群列表(app 模式向导选择接收者用)。 */
  async function listChats({ token, pageSize = 20, pageToken } = {}) {
    const qs = new URLSearchParams({ page_size: String(pageSize) });
    if (pageToken) qs.set("page_token", pageToken);
    const resp = await fetchImpl(`${apiBase}/im/v1/chats?${qs.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return resp.json();
  }

  /** 群机器人 Webhook 发送(webhook 模式)。 */
  async function sendWebhook(webhook, card) {
    return postJson(webhook, { msg_type: "interactive", card });
  }

  /**
   * 上传本地图片,返回 image_key(卡片 img 元素用)。失败抛错。
   * 使用 FormData/Blob(Node 18+ 内置),接口为 im/v1/images。
   */
  async function uploadImage({ token, filePath }) {
    const form = new FormData();
    form.append("image_type", "message");
    form.append(
      "image",
      new Blob([fs.readFileSync(filePath)]),
      path.basename(filePath)
    );
    const resp = await fetchImpl(`${apiBase}/im/v1/images`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    const r = await resp.json();
    if (!r.data || !r.data.image_key) {
      throw new Error(`上传图片失败: ${JSON.stringify(r)}`);
    }
    return r.data.image_key;
  }

  return { getTenantToken, sendMessage, replyMessage, listChats, sendWebhook, uploadImage };
}

module.exports = { createFeishuClient, API_BASE, TOKEN_CACHE_FILE };
