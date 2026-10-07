"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createFeishuClient } = require("../lib/feishu");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "amb-feishu-"));

function mockFetch(routes) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      for (const [match, resp] of routes) {
        if (url.includes(match)) return { json: async () => resp };
      }
      throw new Error(`mockFetch 未匹配: ${url}`);
    },
  };
}

test("getTenantToken:首次获取并写缓存", async () => {
  const cache = path.join(tmp, "t1.json");
  const { calls, fetchImpl } = mockFetch([
    ["tenant_access_token/internal", { tenant_access_token: "tk-1", expire: 7200 }],
  ]);
  const client = createFeishuClient({ fetchImpl, tokenCachePath: cache });
  const token = await client.getTenantToken("cli_x", "sec");
  assert.equal(token, "tk-1");
  assert.equal(calls.length, 1);
  const saved = JSON.parse(fs.readFileSync(cache, "utf8"));
  assert.equal(saved.token, "tk-1");
  assert.ok(saved.expire_at > Date.now() / 1000 + 7000);
});

test("getTenantToken:缓存命中(过期前 60 秒内)不再请求", async () => {
  const cache = path.join(tmp, "t2.json");
  fs.writeFileSync(
    cache,
    JSON.stringify({ token: "tk-cached", expire_at: Date.now() / 1000 + 120 })
  );
  const { calls, fetchImpl } = mockFetch([
    ["tenant_access_token/internal", { tenant_access_token: "tk-new" }],
  ]);
  const client = createFeishuClient({ fetchImpl, tokenCachePath: cache });
  assert.equal(await client.getTenantToken("cli_x", "sec"), "tk-cached");
  assert.equal(calls.length, 0);
});

test("getTenantToken:缓存临期(60 秒内过期)重新获取", async () => {
  const cache = path.join(tmp, "t3.json");
  fs.writeFileSync(
    cache,
    JSON.stringify({ token: "tk-stale", expire_at: Date.now() / 1000 + 30 })
  );
  const { calls, fetchImpl } = mockFetch([
    ["tenant_access_token/internal", { tenant_access_token: "tk-fresh" }],
  ]);
  const client = createFeishuClient({ fetchImpl, tokenCachePath: cache });
  assert.equal(await client.getTenantToken("cli_x", "sec"), "tk-fresh");
  assert.equal(calls.length, 1);
});

test("getTenantToken:飞书返回错误时抛错并透传返回码", async () => {
  const { fetchImpl } = mockFetch([
    ["tenant_access_token/internal", { code: 10003, msg: "invalid app_id" }],
  ]);
  const client = createFeishuClient({ fetchImpl, tokenCachePath: "" });
  await assert.rejects(
    () => client.getTenantToken("bad", "sec"),
    /10003.*invalid app_id|invalid app_id/
  );
});

test("sendMessage:携带鉴权头与 receive_id_type", async () => {
  const { calls, fetchImpl } = mockFetch([["/im/v1/messages", { code: 0, data: { message_id: "om_1" } }]]);
  const client = createFeishuClient({ fetchImpl, tokenCachePath: "" });
  const resp = await client.sendMessage({
    token: "tk-1",
    receiveIdType: "open_id",
    receiveId: "ou_x",
    msgType: "text",
    content: JSON.stringify({ text: "hi" }),
  });
  assert.equal(resp.code, 0);
  const { url, init } = calls[0];
  assert.ok(url.includes("receive_id_type=open_id"));
  assert.equal(init.headers.Authorization, "Bearer tk-1");
  const body = JSON.parse(init.body);
  assert.equal(body.receive_id, "ou_x");
  assert.equal(body.msg_type, "text");
});

test("listChats:透传 page_token 且带鉴权头", async () => {
  const { calls, fetchImpl } = mockFetch([["/im/v1/chats", { code: 0, data: { items: [] } }]]);
  const client = createFeishuClient({ fetchImpl, tokenCachePath: "" });
  await client.listChats({ token: "tk-1", pageSize: 20, pageToken: "pt-9" });
  const { url, init } = calls[0];
  assert.ok(url.includes("page_size=20") && url.includes("page_token=pt-9"));
  assert.equal(init.headers.Authorization, "Bearer tk-1");
});

test("sendWebhook:msg_type=interactive 且卡片在 card 字段", async () => {
  const { calls, fetchImpl } = mockFetch([["bot/v2/hook", { code: 0 }]]);
  const client = createFeishuClient({ fetchImpl, tokenCachePath: "" });
  await client.sendWebhook("https://open.feishu.cn/open-apis/bot/v2/hook/xxx", { schema: "2.0" });
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.msg_type, "interactive");
  assert.deepEqual(body.card, { schema: "2.0" });
});

test("uploadImage:FormData 上传并返回 image_key", async () => {
  const fs = require("node:fs");
  const img = path.join(tmp, "img.png");
  fs.writeFileSync(img, "fake-png");
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { json: async () => ({ code: 0, data: { image_key: "img_v2_abc" } }) };
  };
  const client = createFeishuClient({ fetchImpl, tokenCachePath: "" });
  const key = await client.uploadImage({ token: "tk-1", filePath: img });
  assert.equal(key, "img_v2_abc");
  assert.ok(calls[0].url.endsWith("/im/v1/images"));
  assert.equal(calls[0].init.headers.Authorization, "Bearer tk-1");
  assert.ok(calls[0].init.body instanceof FormData);
  assert.ok(calls[0].init.body.has("image_type"));
});

test("uploadImage:飞书返回错误时抛错", async () => {
  const img = path.join(tmp, "img2.png");
  fs.writeFileSync(img, "x");
  const fetchImpl = async () => ({ json: async () => ({ code: 230001, msg: "file is empty" }) });
  const client = createFeishuClient({ fetchImpl, tokenCachePath: "" });
  await assert.rejects(() => client.uploadImage({ token: "tk", filePath: img }), /230001|file is empty/);
});
