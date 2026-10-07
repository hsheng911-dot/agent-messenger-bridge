# Claude Code × 飞书交互卡片(agent-messenger-bridge)

> 📋 需求规格说明见 [`REQUIREMENTS.md`](REQUIREMENTS.md);行为契约(OpenSpec)见 [`openspec/`](openspec/)。
> 本文档是**安装与使用手册**。运行时:Node.js ≥ 18。

Claude Code 每轮任务结束(`Stop` hook)自动往飞书推一张卡片:问答、**本轮改了哪些文件**、截图直接可见;在飞书点按钮或直接回消息,Claude Code 继续干活。

```
Claude Code 结束一轮
      │  Stop hook(node lib/notify-card.js)
      ▼
飞书卡片(问答 + 改动 diff + 按钮)
      │  点按钮 / 回复提示词
      ▼
bridge(lib/bridge.js,WS 长连接)
      │  三级投递:tmux → claude -p → inbox
      ▼
Claude Code 继续执行,结果回发飞书
```

---

## ⚠️ 两种模式的能力差别

| | 模式 A:群自定义机器人(Webhook) | 模式 B:企业自建应用机器人 |
|---|---|---|
| 配置成本 | 约 5 分钟 | 约 15 分钟(向导引导) |
| 发卡片(含图片展示) | ✅ | ✅ |
| 按钮回调 / 命令 / diff / 停止 / 提示词转发 | ❌ | ✅ |

飞书官方限制:请求回调交互仅适用于应用发送的卡片。只要通知选 A,要交互闭环选 B(推荐)。

---

## 快速开始(模式 B:企业自建应用,推荐)

### 1. 安装

```bash
cd claude-feishu-card
node bin/setup.js
```

向导会分步引导:

1. **运行时探测**:node ≥ 18、tmux(可选)、claude(可选)
2. **模式选择**:1 webhook / 2 app
3. **凭证**:检测到旧 `~/.claude/feishu.env` 会提示沿用;没有应用可看创建指引(自动打开浏览器)
4. **凭证现场验证**:当场换 `tenant_access_token`,失败自动回菜单重试
5. **选接收者**:拉取机器人所在群列表编号选择(只用单聊时可沿用现有配置,`im/v1/chats` 不列单聊属正常)
6. **选项**:去抖秒数(默认 45)、展示轮数(默认 1),回车取默认
7. **自动完成**:写 `~/.claude/feishu-card.json` → 备份并合并 `settings.json` 的 Stop hook → 安装 SDK → 后台拉起 bridge → 发测试卡片

### 2. 飞书开放平台配置(向导结尾有深链清单)

- 应用能力开启「机器人」
- 权限:`im:message`、`im:message.p2p_msg:readonly`、`im:message.group_at_msg:readonly`
- 事件配置:订阅方式选**长连接**,添加事件 `im.message.receive_v1`
- 回调配置:添加 `card.action.trigger`
- **创建版本并发布** —— 不发布不生效

### 3. 验证

在 Claude Code 里跑个任务 → 飞书收到卡片 → 点「▶ 继续」→ toast 提示 → Claude 继续,结果回发飞书。

### 启动 bridge(每次开机后)

```bash
node lib/bridge.js        # 前台运行,日志直出
# 或后台:
# start /b node lib\bridge.js   (Windows)
# nohup node lib/bridge.js &    (macOS/Linux)
```

> 单实例守卫:重复启动会提示 pid 并退出。

---

## 模式 A:群自定义机器人(只要通知)

1. 群设置 → 群机器人 → 添加自定义机器人,复制 Webhook 地址
2. `node bin/setup.js` 选 1,粘贴 Webhook(现场发测试消息验证)
3. 完事。此模式无按钮回调(卡片内会提示),配置 `btn_link` 可让按钮跳转网页

---

## 卡片内容

```
✅ Claude Code 任务完成 · 项目名
⏱ 本轮耗时 2分23秒 · 🔢 Token 输入(含缓存) 2.9M · 输出 2.8k
────────────────────
🙋 用户提问(本轮对话)          ← 提问里的截图直接显示
   「跑一下测试」
🤖 AI 输出                      ← 该轮最后一段结论(非工具流水)
   「测试全部通过…」
────────────────────
[▶ 继续] [🔍 自查] [📦 提交] [✅ 结束]
[🧭 全部会话]
```

控制展示:轮数(`turns`)、AI 输出截断(`max_chars`)见配置表。

---

## 在飞书里操作

### 命令

| 命令 | 作用 |
|---|---|
| `/list` | 列出**正在执行**的会话(带最近提问) |
| `/list 5` | 最近 5 个会话(不限状态) |
| `/focus 2` | 选中第 2 个会话(回复确认消息) |
| `/status` | 查看当前选中 |
| `/diff` | 选中会话目录的改动清单,每文件「详情」按钮看单文件 diff |
| `/stop` 或 `停止` | 终止选中的会话(tmux 发 Ctrl+C;Windows 结束 claude 进程树) |
| `/help` | 帮助 |

自然语句「有哪些会话」「在跑什么」触发列表;群聊里记得 **@机器人**。

### 选中之后:直接打字就是指令

`/focus` 选中会话后,**直接发送文字**即可把提示词提交给该会话执行(claude -p 兜底时会回发结果摘要);发「停止」终止该会话;未选中时发文字不会误触发。

### 四个按钮

| 按钮 | 注入指令 |
|---|---|
| ▶ 继续 | 继续执行未完成部分,做完再汇报 |
| 🔍 自查 | 代码自查:bug / 边界 / 安全 / 性能 |
| 📦 提交 | 整理规范 git commit(不 push) |
| ✅ 结束 | 输出简短总结 |

指令模板在 `lib/bridge.js` 的 `ACTION_PROMPTS` 里改。

### 会话状态怎么判

进程表 `ps` + `tmux` + `~/.claude/projects/**/*.jsonl` mtime 三源交叉(子 agent transcript 自动排除):

| 状态 | 条件 |
|---|---|
| 🔄 执行中 | transcript 60 秒内有写入,或进程 CPU ≥ 5% |
| ⏸ 等待输入 | 进程在,transcript 停更 |
| ✅ 已结束 | 无进程,或超 10 分钟未更新 |

阈值在 `lib/session-scanner.js` 顶部:`ACTIVE_SEC=60`、`IDLE_SEC=600`。手动看:`node lib/session-scanner.js [--json]`

---

## 手动配置(不想跑向导)

`~/.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [{ "hooks": [{ "type": "command", "command": "node C:\\<安装目录>\\lib\\notify-card.js", "async": true, "timeout": 20 }] }]
  }
}
```

`~/.claude/feishu-card.json`(字段见 [`REQUIREMENTS.md`](REQUIREMENTS.md) §6.3/§14)。

app 模式需要依赖:`npm install`(装 `@larksuiteoapi/node-sdk`)。

---

## 常见问题

**Q:为什么用 `Stop` 而不用 `SessionEnd`?**
`SessionEnd` 只有约 1.5 秒预算,网络请求经常发不完。`Stop` 配合 `async: true` 不阻塞主流程。

**Q:卡片刷屏?**
45 秒去抖(同会话),配置 `debounce_sec: 0` 每轮都发。

**Q:点了按钮没反应?**
1. 应用是否**发布**了版本(改配置后必须重新发布)
2. `card.action.trigger` 回调是否添加
3. bridge 是否在运行(`node lib/bridge.js`;查 `~/.claude/feishu-bridge/bridge.log`)
4. 是不是 webhook 机器人发的卡片(模式 A 不支持回调)
5. 卡片回调有效期 14 天

**Q:命令回复 "Invalid access token"(99991663)?**
v2.0 已修复(token 自动换新)。若仍出现,重启 bridge。

**Q:重复启动 bridge 报 "已有 bridge 在运行"?**
单实例守卫(飞书每 app 只允许一条长连接)。`taskkill /PID <pid> /F` 后重启。

**Q:没有 tmux 会怎样?**
按钮指令走 `claude -p` 无头会话兜底(在目标项目目录新起一个会话执行,完成后结果回发飞书);注意它是**新会话**,不是接续原会话。Windows 会自动探测 `claude`/`claude.cmd`。

**Q:「停止」终止不了?**
需要该会话至少触发过一次 Stop hook(进程链记录在会话上下文里)。新起的会话先跑一轮再停。

**Q:飞书客户端版本?**
卡片 JSON 2.0 需 7.20+。老版本标题正常、正文显示升级提示。

**Q:凭证安全?**
`~/.claude/feishu-card.json` 权限 600,别提交进 git。排查日志:`~/.claude/feishu-bridge/bridge.log` 与 `notify.log`;连通性诊断可用 `node spike/spike-ws.js`。

---

## 文件清单

| 文件 | 作用 |
|---|---|
| `REQUIREMENTS.md` | 需求规格说明(SRS) |
| `bin/setup.js` | 交互式安装向导(`node bin/setup.js`) |
| `lib/notify-card.js` | Stop hook 发卡片脚本 |
| `lib/bridge.js` | 桥接服务(长连接 + 回调 + 命令 + 投递) |
| `lib/session-scanner.js` | 会话扫描(可独立运行) |
| `lib/transcript.js` | transcript 轮次解析 |
| `lib/config.js` / `lib/feishu.js` | 配置读取 / 飞书 REST 客户端 |
| `test/` | 90 项单测(`npm test`) |
| `spike/spike-ws.js` | 飞书连通性诊断 |
| `openspec/` | 行为契约与变更记录 |
