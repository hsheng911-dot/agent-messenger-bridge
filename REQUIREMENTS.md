# Claude Code × 飞书交互卡片 —— 需求规格说明

| 项目 | 内容 |
|---|---|
| 文档名称 | Claude Code × 飞书交互卡片(agent-messenger-bridge)需求规格说明(SRS) |
| 版本 | v2.0 |
| 日期 | 2026-10-07 |
| 状态 | 已实现(v2.0 Node.js 版全量功能已交付,90 项单测通过) |
| 交付物 | `bin/setup.js` / `lib/notify-card.js` / `lib/bridge.js` / `lib/session-scanner.js` / `lib/transcript.js` / `lib/config.js` / `lib/feishu.js` |
| 配套文档 | `README.md`(安装与使用)、`openspec/`(行为契约与变更记录) |
| 变更说明 | v2.0 运行时从 Python 迁移到 Node.js,新增图片展示、diff 查询、提示词转发、会话终止等能力,详见 §4 |

---

## 1. 背景与问题

### 1.1 现状

Claude Code 是终端内运行的 AI 编程助手。开发者在一次任务中通常会有较长等待:模型推理、工具执行、跑测试、构建。实践中的痛点是:

1. **不知道什么时候结束**。任务完成后没有主动通知,开发者要么守在终端前,要么反复切回去看。
2. **结束后想继续需要回到电脑前**。"跑完了帮我再审一遍"这种轻量追加指令,必须人坐在终端前才能发。
3. **结束后看不清改了什么**。AI 修改了哪些文件、增删了多少,要回终端跑 git 命令才知道。

### 1.2 目标用户

- 主力使用 Claude Code 的开发者
- 习惯用飞书作为工作消息中枢的团队
- 有远程 / 异步协作诉求,希望能用手机掌握开发机状态并继续指挥

### 1.3 期望达成的效果

把"任务完成"这件事从**终端内的一次静默结束**,变成**飞书里一条可交互的消息**:看得到问答、看得到改动、回一句话就能让 Claude 继续工作。

---

## 2. 目标与非目标

### 2.1 目标(In Scope)

| 编号 | 目标 |
|---|---|
| G1 | Claude Code 每轮任务结束时,主动把结果推送到飞书 |
| G2 | 推送内容包含**本轮用户提问(含图片)与 AI 最终结论** |
| G3 | 飞书卡片提供交互按钮,点击后指令注入运行中的 Claude Code 会话 |
| G4 | 支持在飞书用命令查询本机会话、查看改动 diff、终止会话 |
| G5 | 选中会话后可直接输入提示词,提交给该会话执行 |
| G6 | 一条命令进入安装向导:分步引导、凭证现场验证、群列表选接收者 |

### 2.2 非目标(Out of Scope)

| 编号 | 非目标 | 说明 |
|---|---|---|
| NG1 | 不做多机聚合 | 只扫描桥接服务所在机器 |
| NG2 | 不做指令结果回写卡片 | Claude 的新回复以新卡片推送(见 §12 未来需求) |
| NG3 | 不做权限管控 / 审批 | 任何能看到卡片的人都可点击按钮 |
| NG4 | 不做 Web 管理界面 | 仅命令行向导 + 飞书交互 |
| NG5 | 不替代 Claude Code 自身的终端体验 | 定位为旁路增强,不介入主流程 |
| NG6 | 不发布 npm registry | 先本地使用(`node bin/setup.js`) |

---

## 3. 术语

| 术语 | 含义 |
|---|---|
| Stop hook | Claude Code 在每轮回答结束时触发的钩子事件 |
| transcript | Claude Code 的会话记录文件,JSONL 格式,位于 `~/.claude/projects/**/*.jsonl` |
| 卡片回调 | `card.action.trigger`,用户点击卡片组件后飞书推送给服务端的事件 |
| 长连接 | 飞书 SDK 的 WebSocket 订阅模式,无需公网回调地址 |
| 自定义机器人 | 群内添加的 Webhook 机器人,只能发消息,**不支持回调** |
| 企业自建应用 | 飞书开放平台创建的自建应用,支持完整事件与回调 |
| focus | 当前选中的会话,决定命令与投递的目标 |
| 去抖 | 同一会话在短时间内多次结束只发一次通知 |

---

## 4. 功能需求

优先级采用 MoSCoW:**M**ust / **S**hould / **C**ould / **W**on't(本次不做)。

### FR-1 任务完成通知(M)

| 项 | 内容 |
|---|---|
| 描述 | Claude Code 每轮任务结束时,自动向飞书推送一条消息 |
| 触发时机 | Claude Code `Stop` hook,命令为 `node <安装目录>/lib/notify-card.js` |
| 说明 | 不使用 `SessionEnd`,因其仅约 1.5 秒预算,网络请求经常发不完 |

**验收标准**

- [x] `Stop` hook 注册后,Claude Code 完成一轮即触发脚本
- [x] 脚本以 `async: true` 运行,不阻塞 Claude Code 主流程
- [x] 脚本内部全量异常捕获,任何失败(含 stdin 为空、配置缺失、网络错误)都以 `exit 0` 退出
- [x] 运行日志持久化到 `~/.claude/feishu-bridge/notify.log`

### FR-2 卡片包含本轮问答(M)

| 项 | 内容 |
|---|---|
| 描述 | 卡片正文展示**最近结束这一轮**的用户提问与 AI 最终结论 |
| 数据来源 | Claude Code 提供的 `transcript_path`,解析 JSONL(`lib/transcript.js`) |

**解析规则**

| 规则 | 说明 |
|---|---|
| R2.1 | 一轮 = 一条用户消息 + 到下一轮用户消息之前的所有 assistant 输出 |
| R2.2 | `tool_result` 类型的 user 消息**不算提问**,须跳过 |
| R2.3 | `isMeta` 记录(斜杠命令/技能展开注入)**不算提问**,须跳过 |
| R2.4 | 清理 `<system-reminder>` / `<command-name>` / `<command-message>` 注入;`<command-args>` 保留内容 |
| R2.5 | AI 输出展示该轮**最后一段面向用户的文字**(不含工具调用流水);同 id 流式重复落盘以最新为准,usage 只计一次 |
| R2.6 | 最后一轮若只有提问没有回答,整轮丢弃;会话开头无提问的输出归入"（会话开头的输出）"轮 |
| R2.7 | 内容统一放入代码块渲染,其中的 ` ``` ` 替换为 `'''` |

**验收标准**

- [x] 默认展示最近 1 轮;配置轮数 N 展示最近 N 轮;`0` 展示整个会话
- [x] 提问区不出现工具回显污染与技能展开内容
- [x] 与 Python 参照实现的对照测试锁定(question/token/耗时逐字段)

### FR-2.1 提问图片展示(M)

| 项 | 内容 |
|---|---|
| 描述 | 提问中的本地图片标记(`[Image: source: 路径]`)被提取,图片上传飞书后以卡片 img 元素直接展示 |

**验收标准**

- [x] 最多上传 2 张、单张 ≤10MB、文件需存在;失败降级为文字说明并保留原图路径
- [x] webhook 模式跳过上传
- [x] 提问文字区不再出现路径标记

### FR-3 卡片交互按钮(M)

| 按钮 | `value.action` | 注入指令 |
|---|---|---|
| ▶ 继续 | `continue` | 继续执行未完成部分,做完再汇报 |
| 🔍 自查 | `review` | 代码自查:bug / 边界 / 安全 / 性能 |
| 📦 提交 | `commit` | 整理成规范 git commit 并提交(不 push) |
| ✅ 结束 | `done` | 任务验收结束,输出简短总结 |
| 🧭 全部会话 | `list` | 原地替换卡片为**仅执行中会话**的列表 |

**约束**:按钮回调必须使用企业自建应用模式(自定义机器人不支持回调,自动降级)。

**验收标准**

- [x] 回调 payload 为扁平结构(`action.value` 顶层),同步返回 toast 生效(WSClient spike 实测)
- [x] 自定义机器人模式下按钮自动降级(配置跳转链接时为 open_url,否则省略)

### FR-4 飞书命令查询会话(M)

| 命令 | 别名 | 行为 |
|---|---|---|
| `/list` | `/ls` `/sessions` `/会话` `/claude` `/ps` | 返回会话列表卡片,仅执行中的会话 |
| `/list N` | — | 显示最近 N 个会话(不限状态) |
| `/focus N` | `/f N` `/选中 N` `/切换 N` | 选中第 N 个会话,回复确认消息(项目/目录/用法提示) |
| `/status` | `/状态` | 查看当前选中会话 |
| `/diff` | — | 查看选中会话目录的改动清单(见 FR-6.1) |
| `/stop` | `/停止`、`停止` | 终止选中会话(见 FR-6.2) |
| `/help` | `/帮助` | 返回帮助文本 |

**FR-4.1** 支持中文自然语句触发列表:"有哪些会话"、"在跑什么"等。
**FR-4.2** 群聊场景须剥离 `@` 提及(`<at ...>` 与 `@_user_1`)。
**FR-4.3** 非命令消息:选中会话时作为提示词转发(见 FR-6.3),未选中时静默。
**FR-4.4** 按 `message_id` 幂等,飞书重推不重复处理。

### FR-5 会话状态判定(M)

三源交叉:进程表(`ps`,Windows 无则跳过)、`tmux list-panes`、transcript mtime。transcript 递归扫描**排除子 agent**(`subagents` 目录与 `agent-*` 文件)。

| 状态 | 判定条件 |
|---|---|
| 🔄 执行中 | transcript 60 秒内有写入,或进程 CPU ≥ 5% |
| ⏸ 等待输入 | 进程还在,transcript 停更(10 分钟内) |
| ✅ 已结束 | 无进程,或 transcript 超过 10 分钟未更新 |

**阈值**:`lib/session-scanner.js` 顶部 `ACTIVE_SEC=60`、`IDLE_SEC=600`。最近提问从 transcript **尾部**向前查找(读末尾 200KB)。

### FR-6 指令投递与会话控制(M)

**FR-6.1 会话改动 diff 查询**:选中会话后 `/diff` 返回改动清单卡片(文件 + 增删行数,已跟踪走 `git diff HEAD --numstat`,未跟踪标新增,最多 10 个);每个文件带「详情」按钮,点击把该文件具体 diff(超长截断)发送到会话。

**FR-6.2 会话终止**:「停止」/`/stop` 按 tmux Ctrl+C → hook 记录的 claude 祖先进程任务树(`taskkill /T /F`)→ 会话 pid 的顺序终止;均不可行时说明原因。

**FR-6.3 提示词转发**:选中会话后,非命令文本作为提示词提交给该会话执行(投递链同按钮),回发结果摘要。

**FR-6.4 三级投递**:目标会话的 tmux pane(`load-buffer`+`paste-buffer`+`send-keys`)→ 无 tmux 时在目标 cwd 启动 `claude -p` 无头会话执行并回发结果摘要(Windows 下按 PATHEXT 探测 `claude`/`claude.cmd`)→ 均不可用落盘 inbox 队列。

**FR-6.5 目标解析**:显式 `session_id` / `cwd` → 当前 focus。

### FR-7 去抖(S)

同一会话在配置秒数内(默认 45,`0` 禁用)只发一次通知。

### FR-8 安装与配置(M)

**FR-8.1** `node bin/setup.js` 交互式向导:运行时探测(node≥18/tmux/claude)→ 旧 `feishu.env` 检测与预填 → 模式选择 → 凭证现场验证(支持沿用现有/手输/新建指引,凭证失败回菜单)→ app 模式拉群列表选接收者(单聊场景解释 + 沿用现有)→ 选项收集 → 写 `~/.claude/feishu-card.json` → 合并 Stop hook → app 模式装 SDK、拉起 bridge、发测试卡片。

**FR-8.2** 修改 `settings.json` 前自动备份;按 `notify-card.js` / 旧 `notify_card.py` 双标识识别既有条目并就地替换,不产生重复 hook。

**FR-8.3** 单实例守卫:bridge 启动时检测 `bridge.pid`,已有实例在运行则退出(飞书每 app 仅允许一条长连接)。

**FR-8.4** token 每次经缓存层获取(过期前 60 秒自动换新),不在启动时固化,避免 2 小时过期后 401。

---

## 5. 非功能需求

| 编号 | 类别 | 需求 | 实现 |
|---|---|---|---|
| NFR-1 | 可靠性 | 通知失败绝不影响 Claude Code 主流程 | 全量捕获 + `async: true` + 恒 exit 0 |
| NFR-2 | 性能 | hook 冷启动开销小 | notify/scan/transcript 零第三方依赖(内置 fetch);仅 bridge 引 SDK |
| NFR-3 | 安全 | 凭证不进代码仓库 | 存 `~/.claude/feishu-card.json`,权限 600 |
| NFR-4 | 兼容 | Windows / Linux / macOS | cwd 匹配统一分隔符与大小写;Windows claude 走 PATHEXT;`claude -p` 兜底 |
| NFR-5 | 兼容 | 飞书客户端版本 | 卡片 JSON 2.0 需 7.20+ |
| NFR-6 | 可观测 | 服务与 hook 均有日志 | `bridge.log` + `notify.log` |
| NFR-7 | 部署简易 | 无公网域名、无内网穿透 | WS 长连接 |
| NFR-8 | 正确性 | transcript 解析有对照保障 | Python 参照实现的期望快照(`test/expected/`)逐字段对照 |
| NFR-9 | 幂等 | 消息重推 / 重复安装无副作用 | `message_id` 去重;hook 双标识替换;单实例守卫 |

---

## 6. 数据模型

### 6.1 输入:Claude Code hook payload(stdin)

```json
{ "session_id": "...", "transcript_path": "...", "cwd": "...", "hook_event_name": "Stop" }
```

### 6.2 输出:飞书卡片(JSON 2.0)

`schema/config/header/body.elements[]`,元素含 markdown、hr、column_set(按钮)、img(提问图片)。

### 6.3 配置文件 `~/.claude/feishu-card.json`

```json
{
  "mode": "app",              // webhook | app
  "webhook": "https://...",   // webhook 模式
  "btn_link": "",             // webhook 模式按钮跳转
  "app_id": "cli_xxx", "app_secret": "...",
  "receive_id_type": "chat_id", "receive_id": "oc_xxx",
  "debounce_sec": 45, "turns": 1, "max_chars": 1200
}
```

环境变量 `FEISHU_*` 可逐项覆盖(优先级:环境变量 > JSON > 默认)。

### 6.4 状态文件

| 路径 | 用途 |
|---|---|
| `~/.claude/feishu-card.json` | 配置(权限 600) |
| `~/.claude/feishu-bridge/session_<id8>.json` | 会话上下文 `{session_id, cwd, time, ancestors[]}` |
| `~/.claude/feishu-bridge/focus.json` | 当前选中会话 |
| `~/.claude/feishu-bridge/inbox/<ts>_<action>.json` | 指令队列(降级) |
| `~/.claude/feishu-bridge/.last_<id8>` | 去抖时间戳 |
| `~/.claude/feishu-bridge/bridge.pid` | 单实例守卫 |
| `~/.claude/feishu-bridge/bridge.log` / `notify.log` | 服务 / hook 日志 |
| `~/.cache/claude-feishu/tenant_token.json` | token 缓存 |

---

## 7. 外部接口依赖

### 7.1 飞书开放平台

| 接口 | 用途 |
|---|---|
| `POST /auth/v3/tenant_access_token/internal` | 取 tenant token(缓存至过期前 60 秒) |
| `POST /im/v1/messages` / `/{id}/reply` | 发送卡片 / 回复命令 |
| `GET /im/v1/chats` | 群列表(向导选接收者) |
| `POST /im/v1/images` | 上传提问图片 |
| Webhook `/bot/v2/hook/xxx` | webhook 模式发送 |
| 事件 `im.message.receive_v1` / 回调 `card.action.trigger` | 命令与按钮(WSClient 长连接) |

### 7.2 Claude Code / 系统

`Stop` hook(stdin JSON)、`transcript_path`、`CLAUDE_PROJECT_DIR`;`git`、可选 `tmux`、macOS 可选 `lsof`;运行时 **Node.js ≥ 18**(bridge 需 `@larksuiteoapi/node-sdk`)。

---

## 8. 约束与假设

| 编号 | 内容 |
|---|---|
| C1 | 自定义机器人卡片不支持回调,交互按钮必须自建应用 |
| C2 | 已发送卡片回调有效期 14 天;回调须 3 秒内响应 |
| C3 | 卡片 JSON 2.0 需客户端 7.20+ |
| C4 | 开放平台配置变更须创建版本并发布才生效 |
| C5 | 桥接服务与 Claude Code 同机;飞书每 app 仅一条长连接(单实例守卫保证) |
| C6 | 无 tmux 时,Windows / VSCode 场景走 `claude -p` 兜底(新会话,非接续原会话) |
| C7 | Node.js ≥ 18(fetch / FormData 内置) |
| C8 | 飞书群成员可信,按钮无鉴权 |

---

## 9. 运行模式对比

| 维度 | 模式 A:群自定义机器人 | 模式 B:企业自建应用 |
|---|---|---|
| 配置成本 | 约 5 分钟 | 约 15 分钟(向导引导) |
| 发送卡片 | ✅ | ✅(含图片展示) |
| 按钮回调 / 命令 / diff / 停止 / 提示词转发 | ❌ | ✅ |
| 需要公网地址 | 否 | 否(长连接) |

---

## 10. 验收测试

### 10.1 单元与对照(90 项,node --test)

transcript 轮次切分 / isMeta 过滤 / 流式重复落盘 / usage 去重(含 Python 参照快照对照)、配置优先级、token 缓存、卡片构造(按钮双模式、``` 替换、截断)、去抖、命令解析全分支、投递决策树、状态判定全分支、settings.json 合并/替换/备份、旧配置映射、diff 解析与卡片、提示词转发、会话终止三路径。

### 10.2 真机已验证

| 用例 | 结果 |
|---|---|
| WSClient 收 `card.action.trigger` + 同步 toast | ✅(spike) |
| 安装向导 app 分支全程 + 测试卡片 | ✅ |
| Stop hook 卡片(问答/图片/最后一段结论) | ✅ |
| /list、/list 5、/focus、选中确认消息、/status | ✅ |
| 按钮 → claude -p 兜底执行并回发 | ✅ |
| token 过期后命令失败 → 已修复为自动换新 | ✅ |

### 10.3 待真实环境复验

tmux 注入(本机无 tmux,单测覆盖)、webhook 模式实机、群聊 @机器人、macOS/Linux 全流程。

---

## 11. 风险与对策

| 编号 | 风险 | 对策 |
|---|---|---|
| R1 | 忘记发布版本 | 向导结尾深链清单强调 |
| R2 | 通知刷屏 | 45 秒去抖,可配 0 |
| R3 | transcript 格式变化 | 多分支容错;`last_assistant_message` 兜底;fixture 对照测试 |
| R4 | 长连接断开 | SDK 自动重连;`bridge.log` 可查;单实例守卫防双实例互抢 |
| R5 | token 过期 | 每次经缓存层获取,自动换新 |
| R6 | 卡片泄露敏感代码 | `max_chars` 限长;文档提示 |
| R7 | claude -p 兜底是新会话 | 文档明示;tmux 场景可接续原会话 |

---

## 12. 未来需求(v2.0 未实现)

| 编号 | 需求 | 说明 |
|---|---|---|
| F1 | 多机会话聚合 | 注册中心,各机上报 |
| F2 | 指令结果回写原卡片 | 点击后更新原卡片状态 |
| F3 | 回复卡片即对话 | 按 parent_id 直接路由到该卡片的会话,免去 focus |
| F4 | 敏感操作二次确认 | commit 等按钮加审批 |
| F5 | npm 发布 + CI | `npx agent-messenger-bridge`;GitHub Actions |
| F6 | bridge 常驻托管 | 计划任务 / launchd / systemd,开机自启与崩溃重启 |
| F7 | 卸载命令 | `--uninstall` 还原 hook 与配置 |
| F8 | tmux 真机验证 | 有 tmux 的环境实测注入 |

---

## 13. 需求追溯矩阵

| 需求 | 实现位置 |
|---|---|
| FR-1 完成通知 | `bin/setup.js`(hook 注册)、`lib/notify-card.js` |
| FR-2 问答与图片 | `lib/transcript.js`、`lib/notify-card.js: buildCard() / splitQuestionImages()` |
| FR-3 交互按钮 | `lib/notify-card.js: buttonColumns()`、`lib/bridge.js: handleCardAction()` |
| FR-4 命令查询 | `lib/bridge.js: parseCommand() / handleCommand() / handleMessageEvent()` |
| FR-5 状态判定 | `lib/session-scanner.js` |
| FR-6 投递与控制 | `lib/bridge.js: deliver() / deliverStop() / deliverToClaudeP() / gitDiffFiles()` |
| FR-7 去抖 | `lib/notify-card.js: debounced()` |
| FR-8 安装配置 | `bin/setup.js`、`lib/bridge.js: startBridge()`(单实例守卫) |

---

## 14. 配置项总表

| JSON 字段(环境变量) | 默认 | 说明 |
|---|---|---|
| `mode` (FEISHU_MODE) | `webhook` | `webhook` / `app` |
| `webhook` (FEISHU_WEBHOOK) | — | 模式 A 必填 |
| `btn_link` (FEISHU_BTN_LINK) | 空 | 模式 A 按钮跳转 |
| `app_id` / `app_secret` (FEISHU_APP_ID/SECRET) | — | 模式 B 必填 |
| `receive_id_type` (FEISHU_RECEIVE_ID_TYPE) | `chat_id` | `chat_id` / `open_id` |
| `receive_id` (FEISHU_RECEIVE_ID) | — | 模式 B 必填,如 `oc_xxx` |
| `debounce_sec` (FEISHU_DEBOUNCE_SEC) | `45` | 去抖秒数,`0` = 每轮都发 |
| `turns` (FEISHU_TURNS) | `1` | 展示最近几轮,`0` = 全部 |
| `max_chars` (FEISHU_MAX_CHARS) | `1200` | AI 输出最大字符数 |
| `CLAUDE_TMUX_PANE` | 自动探测 | 强制指定注入的 pane |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Claude 配置目录 |
