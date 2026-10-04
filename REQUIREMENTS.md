# Claude Code × 飞书交互卡片 —— 需求规格说明

| 项目 | 内容 |
|---|---|
| 文档名称 | Claude Code × 飞书交互卡片 需求规格说明（SRS） |
| 版本 | v1.2 |
| 日期 | 2026-10-04 |
| 状态 | 已实现（v1.2 全量功能已交付并通过本地验证） |
| 交付物 | `notify_card.py` / `bridge_server.py` / `session_scanner.py` / `install.sh` |
| 配套文档 | `README.md`（安装与使用） |

---

## 1. 背景与问题

### 1.1 现状

Claude Code 是终端内运行的 AI 编程助手。开发者在一次任务中通常会有较长等待：模型推理、工具执行、跑测试、构建。实践中的痛点是：

1. **不知道什么时候结束**。任务完成后没有主动通知，开发者要么守在终端前，要么反复切回去看。
2. **结束后想继续需要回到电脑前**。"跑完了帮我再审一遍"这种轻量追加指令，必须人坐在终端前才能发。
3. **离开电脑后完全失控**。下班、开会、通勤时，无法了解本机有哪些任务在跑、跑到哪一步。

### 1.2 目标用户

- 主力使用 Claude Code 的开发者
- 习惯用飞书作为工作消息中枢的团队
- 有远程 / 异步协作诉求，希望能用手机掌握开发机状态

### 1.3 期望达成的效果

把"任务完成"这件事从**终端内的一次静默结束**，变成**飞书里一条可交互的消息**；再进一步，让飞书能反向驱动 Claude Code 继续工作。

---

## 2. 目标与非目标

### 2.1 目标（In Scope）

| 编号 | 目标 |
|---|---|
| G1 | Claude Code 每轮任务结束时，主动把结果推送到飞书 |
| G2 | 推送内容包含**本轮用户提问与 AI 输出**，无需回到终端即可判断结果 |
| G3 | 飞书卡片提供交互按钮，点击后指令注入正在运行的 Claude Code 会话 |
| G4 | 支持在飞书用命令查询本机所有 Claude Code 会话及其状态 |
| G5 | 安装配置成本可控，不引入公网域名 / 内网穿透等基础设施依赖 |

### 2.2 非目标（Out of Scope）

| 编号 | 非目标 | 说明 |
|---|---|---|
| NG1 | 不做多机聚合 | v1.2 只扫描桥接服务所在机器的进程 |
| NG2 | 不做指令结果回写卡片 | 点击"继续"后不会把 Claude 的新回复推回原卡片（见 §11 未来需求） |
| NG3 | 不做权限管控 / 审批 | 任何能看到卡片的人都可点击按钮 |
| NG4 | 不做 Web 管理界面 | 仅命令行 + 飞书交互 |
| NG5 | 不替代 Claude Code 自身的终端体验 | 定位为旁路增强，不介入主流程 |

---

## 3. 术语

| 术语 | 含义 |
|---|---|
| Stop hook | Claude Code 在每轮回答结束时触发的钩子事件 |
| SessionEnd hook | Claude Code 进程退出时触发，预算约 1.5 秒 |
| transcript | Claude Code 的会话记录文件，JSONL 格式，位于 `~/.claude/projects/**/*.jsonl` |
| 卡片回调 | `card.action.trigger`，用户点击卡片组件后飞书推送给服务端的事件 |
| 长连接 | 飞书 SDK 的 WebSocket 订阅模式，无需公网回调地址 |
| 自定义机器人 | 群内添加的 Webhook 机器人，只能发消息，**不支持回调** |
| 企业自建应用 | 飞书开放平台创建的自建应用，支持完整事件与回调 |
| focus | 当前选中的会话，决定交互按钮的指令投递目标 |
| 去抖 | 同一会话在短时间内多次结束只发一次通知 |

---

## 4. 功能需求

优先级采用 MoSCoW：**M**ust / **S**hould / **C**ould / **W**on't（本次不做）。

### FR-1 任务完成通知（M）

| 项 | 内容 |
|---|---|
| 描述 | Claude Code 每轮任务结束时，自动向飞书推送一条消息 |
| 触发时机 | Claude Code `Stop` hook |
| 说明 | 不使用 `SessionEnd`，因其仅约 1.5 秒预算，网络请求经常发不完 |

**验收标准**

- [x] `Stop` hook 注册后，Claude Code 完成一轮即触发脚本
- [x] 脚本以 `async: true` 运行，不阻塞 Claude Code 主流程
- [x] 脚本内部全量异常捕获，通知失败**不会**导致 Claude Code 报错或中断
- [x] 脚本始终以 `exit 0` 退出

### FR-2 卡片包含本轮问答（M）

| 项 | 内容 |
|---|---|
| 描述 | 卡片正文展示**最近结束这一轮**的用户提问与 AI 输出 |
| 数据来源 | Claude Code 提供的 `transcript_path`，解析 JSONL |

**解析规则**

| 规则 | 说明 |
|---|---|
| R2.1 | 一轮 = 一条 user 消息 + 到下一轮 user 之前的所有 assistant 输出 |
| R2.2 | `tool_result` 类型的 user 消息**不算提问**，须跳过 |
| R2.3 | 剥离 Claude Code 注入的 `<system-reminder>` / `<command-name>` |
| R2.4 | assistant 的工具调用记为 `🔧 调用 <name> <target>`，并入当轮输出 |
| R2.5 | 最后一轮若只有提问没有回答，整轮丢弃 |
| R2.6 | 内容统一放入代码块渲染，且其中的 ` ``` ` 替换为 `'''`，防止破坏卡片结构 |

**验收标准**

- [x] 默认展示最近 1 轮
- [x] `FEISHU_TURNS=N` 可展示最近 N 轮；设为 `0` 展示整个会话全部轮次
- [x] 提问区不出现工具回显污染
- [x] AI 输出中的 markdown 不会破坏卡片渲染

### FR-3 卡片交互按钮（M）

| 按钮 | `value.action` | 注入指令 |
|---|---|---|
| ▶ 继续 | `continue` | 继续执行未完成部分，做完再汇报 |
| 🔍 自查 | `review` | 代码自查：bug / 边界 / 安全 / 性能 |
| 📦 提交 | `commit` | 整理成规范 git commit 并提交（不 push） |
| ✅ 结束 | `done` | 任务验收结束，输出简短总结 |
| 🧭 全部会话 | `list` | 原地替换卡片为会话列表 |

**约束**：按钮回调**必须**使用企业自建应用模式。飞书官方明确——请求回调交互仅适用于通过应用发送的卡片，绑定自定义机器人发送的卡片不支持回调。

**验收标准**

- [x] 自建应用模式下 4 个指令按钮 + 1 个查询按钮正常渲染
- [x] 点击后飞书推送 `card.action.trigger`，服务在 **3 秒内**响应 toast
- [x] 自定义机器人模式下按钮自动降级，避免点击报错

### FR-4 飞书命令查询会话（S）

| 命令 | 别名 | 行为 |
|---|---|---|
| `/list` | `/ls` `/sessions` `/会话` `/claude` `/ps` | 返回会话列表卡片 |
| `/focus N` | `/f N` `/选中 N` | 选中第 N 个会话 |
| `/status` | `/状态` | 查看当前选中会话 |
| `/help` | `/帮助` | 返回帮助文本 |

**FR-4.1** 支持中文自然语句触发："有哪些会话"、"在跑什么"、"查看会话"、"选中第2个"。

**FR-4.2** 群聊场景下须正确剥离 `@` 提及后再解析命令（`<at user_id=...>...</at>` 与 `@_user_1` 两种形态）。

**FR-4.3** 非命令消息（普通聊天）不回复，避免打扰。

**验收标准**

- [x] 21 种输入变体解析正确（含大小写、前后空格、@ 提及、中文）
- [x] 消息去重，飞书重推同一 `message_id` 不重复处理
- [x] `/focus` 越界给出明确范围提示

### FR-5 会话状态判定（M）

三个信息源交叉验证：

| 源 | 提供信息 |
|---|---|
| 进程表 `ps` | pid / CPU / 运行时长 / cwd |
| `tmux list-panes` | 跑着 claude 的 pane id |
| transcript mtime | 真实活跃度证据 |

| 状态 | 判定条件 |
|---|---|
| 🔄 执行中 | transcript 60 秒内有写入，或进程 CPU ≥ 5% |
| ⏸ 等待输入 | 进程还在，transcript 停更（10 分钟内） |
| ✅ 已结束 | 无进程，或 transcript 超过 10 分钟未更新 |

**阈值可配置**：`session_scanner.py` 顶部 `ACTIVE_SEC=60`、`IDLE_SEC=600`。

**验收标准**

- [x] 已结束的会话不误显示 pid
- [x] Linux 通过 `/proc/<pid>/cwd` 取工作目录；macOS 回退 `lsof`
- [x] 有进程但无 transcript（刚启动尚未落盘）也能出现在列表

### FR-6 指令投递（M）

**FR-6.1** 优先通过 tmux 注入：用 `load-buffer` + `paste-buffer` + `send-keys`，避免特殊字符被 tmux 解释。

**FR-6.2** 找不到 tmux pane 时降级：指令落盘到 `~/.claude/feishu-bridge/inbox/*.json` 等待消费。

**FR-6.3** 目标会话解析顺序：显式 `session_id` / `cwd` → 当前 focus → 列表首个。

**验收标准**

- [x] 有 tmux 时 toast 提示"已注入 tmux `<pane>`"
- [x] 无 tmux 时 toast 提示指令已入队，并给出文件路径

### FR-7 去抖与限流（S）

| 项 | 内容 |
|---|---|
| 描述 | 同一会话在 `FEISHU_DEBOUNCE_SEC` 秒内只发一次通知，默认 45 秒 |
| 目的 | Claude Code 一轮内可能多次触发 Stop，避免卡片刷屏 |

**验收标准**

- [x] 默认 45 秒去抖生效
- [x] 设为 `0` 则每轮都发

### FR-8 安装与配置（S）

**FR-8.1** 提供 `install.sh` 交互式安装：拷贝脚本 → 生成 `feishu.env`（权限 600）→ 合并进 `settings.json`。

**FR-8.2** 修改 `settings.json` 前自动备份为 `settings.json.bak.<时间戳>`。

**FR-8.3** 重复安装时按 `notify_card.py` 关键字识别已有条目并**就地更新**，不产生重复 hook。

**验收标准**

- [x] `settings.json` 已存在时不整体覆盖，仅合并 `hooks.Stop`
- [x] 幂等：多次运行不会产生重复的 Stop hook

---

## 5. 非功能需求

| 编号 | 类别 | 需求 | 实现 |
|---|---|---|---|
| NFR-1 | 可靠性 | 通知失败绝不影响 Claude Code 主流程 | 全量 try-except + `async: true` |
| NFR-2 | 性能 | hook 冷启动开销小，不拖慢每轮结束 | 仅用标准库，无重量级依赖 |
| NFR-3 | 安全 | 凭证不进代码仓库 | 存 `~/.claude/feishu.env`，权限 600 |
| NFR-4 | 安全 | 不向仓库泄漏 Webhook / App Secret | 文档明确警示 |
| NFR-5 | 兼容 | 同时支持 Linux 与 macOS | cwd 获取双路径；`ps -eo` 通用于两者 |
| NFR-6 | 兼容 | 飞书客户端版本要求明确 | 卡片 JSON 2.0 需 7.20+，文档标注 |
| NFR-7 | 可维护 | 纯文本配置，无数据库 / 无守护进程框架 | JSON 文件 + 环境变量 |
| NFR-8 | 可观测 | 桥接服务有日志 | `~/.claude/feishu-bridge/bridge.log` |
| NFR-9 | 部署简易 | 不依赖公网域名、不需内网穿透 | 飞书 SDK 长连接模式 |
| NFR-10 | 幂等 | 消息重推 / 重复安装不产生副作用 | `message_id` 去重；hook 去重 |

---

## 6. 数据模型

### 6.1 输入：Claude Code hook payload（stdin）

```json
{
  "session_id": "abc123...",
  "transcript_path": "~/.claude/projects/-proj/xxx.jsonl",
  "cwd": "/path/to/project",
  "hook_event_name": "Stop",
  "last_assistant_message": "..."   // 可能不存在，需从 transcript 回溯
}
```

### 6.2 输入：transcript（JSONL，每行一条）

```
{"cwd": "...", "type": "user",      "message": {"role":"user",      "content":[{"type":"text",...}]}}
{"type": "assistant",               "message": {"role":"assistant", "content":[{"type":"text"|"tool_use",...}]}}
{"type": "user",                    "message": {"content":[{"type":"tool_result",...}]}}   // 跳过
```

### 6.3 输出：飞书卡片（JSON 2.0）

```
schema / config / header(title, subtitle, template) / body.elements[]
  - markdown  项目 · 分支 · 时间 · 会话
  - hr
  - markdown  🙋 用户提问 + 代码块
  - markdown  🤖 AI 输出  + 代码块
  - hr
  - column_set × N   按钮（2 列布局）
```

### 6.4 状态文件

| 路径 | 用途 | 结构 |
|---|---|---|
| `~/.claude/feishu.env` | 凭证与配置 | `export KEY=value` |
| `~/.claude/feishu-bridge/session_<id8>.json` | 会话上下文 | `{session_id, cwd, time}` |
| `~/.claude/feishu-bridge/focus.json` | 当前选中会话 | `{session_id, cwd, project, status, set_at}` |
| `~/.claude/feishu-bridge/inbox/<ts>_<action>.json` | 指令队列（降级） | `{session_id, action, prompt}` |
| `~/.claude/feishu-bridge/.last_<id8>` | 去抖时间戳 | 浮点数 |
| `~/.claude/feishu-bridge/bridge.log` | 服务日志 | 文本 |
| `~/.cache/claude-feishu/tenant_token.json` | token 缓存 | `{token, expire_at}` |

---

## 7. 外部接口依赖

### 7.1 飞书开放平台

| 接口 | 用途 | 备注 |
|---|---|---|
| `POST /auth/v3/tenant_access_token/internal` | 取 tenant token | 缓存至过期前 60 秒 |
| `POST /im/v1/messages?receive_id_type=` | 发送卡片 | 自建应用模式 |
| `POST /im/v1/messages/{id}/reply` | 回复命令消息 | 以回复形式出现 |
| Webhook `/open-apis/bot/v2/hook/xxx` | 发送卡片 | 自定义机器人模式 |
| 事件 `im.message.receive_v1` | 接收命令 | 需订阅 |
| 回调 `card.action.trigger` | 按钮点击 | 需订阅 |

### 7.2 Claude Code

| 接口 | 用途 |
|---|---|
| `Stop` hook（stdin JSON） | 任务完成触发 |
| `transcript_path` | 解析问答内容 |
| `CLAUDE_PROJECT_DIR` 环境变量 | 项目目录 |

### 7.3 系统

`ps`、`git`、可选 `tmux`、macOS 可选 `lsof`。

---

## 8. 约束与假设

| 编号 | 内容 |
|---|---|
| C1 | **飞书限制**：自定义机器人发送的卡片不支持请求回调，交互按钮必须用自建应用 |
| C2 | **飞书限制**：已发送卡片的回调交互有效期 14 天（卡片 JSON 2.0） |
| C3 | **飞书限制**：回调须在 **3 秒内**响应，否则客户端提示操作失败 |
| C4 | **飞书限制**：卡片 JSON 2.0 需客户端 7.20+，低版本正文显示升级提示 |
| C5 | **飞书限制**：配置变更须**创建版本并发布**才生效 |
| C6 | **部署假设**：桥接服务与 Claude Code 在**同一台机器**上 |
| C7 | **部署假设**：使用 tmux 时指令才能真正回注；否则降级为落盘队列 |
| C8 | **运行环境**：Python 3.10+；自建应用模式需 `lark-oapi` |
| C9 | **安全假设**：飞书群成员可信，按钮无鉴权 |

---

## 9. 运行模式对比

| 维度 | 模式 A：群自定义机器人 | 模式 B：企业自建应用 |
|---|---|---|
| 配置成本 | 约 5 分钟 | 约 15 分钟 |
| 发送卡片 | ✅ | ✅ |
| 按钮回调 | ❌ | ✅ |
| 飞书命令 | ❌ | ✅ |
| 需要公网地址 | 否 | 否（长连接） |
| 适用 | 只要"完成通知" | 需要交互闭环 |

---

## 10. 验收测试

### 10.1 已通过（本地沙盒验证）

| 编号 | 用例 | 结果 |
|---|---|---|
| T1 | 三个脚本 + install.sh 语法编译 | ✅ |
| T2 | 卡片 JSON 可序列化、围栏成对无嵌套破坏 | ✅ |
| T3 | transcript 轮次切分（3 轮含工具调用/工具结果） | ✅ |
| T4 | `<system-reminder>` 剥离 | ✅ |
| T5 | 最后一轮无回答时丢弃 | ✅ |
| T6 | 21 种命令输入变体解析 | ✅ |
| T7 | `/list` 返回卡片，含 3 个"选中 #N"按钮 | ✅ |
| T8 | `/focus 2` 选中并写入 focus.json | ✅ |
| T9 | `/focus 99` 越界提示 | ✅ |
| T10 | `/status` 回显当前选中 | ✅ |
| T11 | 按钮回调 select / continue / 未知 action | ✅ |
| T12 | 无 tmux 时指令降级落盘 inbox | ✅ |
| T13 | 会话状态判定（执行中 / 已结束 / 历史） | ✅ |
| T14 | 完成卡片 5 个按钮渲染 | ✅ |

### 10.2 待真实环境验证

| 编号 | 用例 | 依赖 |
|---|---|---|
| T15 | 真实飞书应用收到卡片 | 需 App ID / Secret |
| T16 | 点击按钮收到 toast | 需应用发布 + 回调订阅 |
| T17 | tmux 注入后 Claude 实际继续工作 | 需 tmux 环境 |
| T18 | 群聊 @机器人 触发 /list | 需机器人入群 |

---

## 11. 风险与对策

| 编号 | 风险 | 影响 | 对策 |
|---|---|---|---|
| R1 | 忘记在开放平台发布版本 | 按钮 / 命令全无反应 | 文档与 install.sh 结尾双重强调 |
| R2 | 用自定义机器人却期待按钮生效 | 点击无响应 | README 顶部显著对比表；卡片内橙色提示 |
| R3 | 通知刷屏 | 打扰 | 默认 45 秒去抖 |
| R4 | transcript 格式随 Claude Code 版本变化 | 解析失效 | 多分支容错；`last_assistant_message` 兜底 |
| R5 | 长连接断开 | 命令无响应 | 日志可查；建议 supervisord / systemd 托管 |
| R6 | 多机场景只看到一台 | 信息不全 | 文档明示；未来需求 F1 |
| R7 | 卡片含代码可能泄露敏感信息 | 安全风险 | 文档提示；`FEISHU_MAX_CHARS` 可限长度 |

---

## 12. 未来需求（v1.2 未实现）

| 编号 | 需求 | 说明 |
|---|---|---|
| F1 | 多机会话聚合 | 引入注册中心，各机上报会话状态 |
| F2 | 指令结果回写卡片 | 点击"继续"后，把 Claude 的新回复更新回原卡片 |
| F3 | 卡片状态流转 | 卡片显示 ⏳ 执行中 → ✅ 已完成 的生命周期 |
| F4 | 敏感操作二次确认 | 对 `commit` 等按钮加审批 |
| F5 | 指令队列消费者 | 自动消费 inbox，无需 tmux 也能继续 |
| F6 | 会话历史检索 | 按关键词搜索历史 transcript |
| F7 | 富文本渲染优化 | 用真正的 markdown 组件替代代码块 |

---

## 13. 需求追溯矩阵

| 需求 | 实现位置 |
|---|---|
| FR-1 完成通知 | `install.sh`（hook 注册）、`notify_card.py: main()` |
| FR-2 卡片问答 | `notify_card.py: recent_turns() / _extract_text() / _clean_user_text() / build_card()` |
| FR-3 交互按钮 | `notify_card.py: btn()`、`bridge_server.py: do_card_action_trigger()` |
| FR-4 命令查询 | `bridge_server.py: parse_command() / handle_command() / do_message_receive()` |
| FR-5 状态判定 | `session_scanner.py: scan_processes() / scan_tmux() / scan_transcripts() / _status_of()` |
| FR-6 指令投递 | `bridge_server.py: deliver() / deliver_to_tmux() / deliver_to_inbox()` |
| FR-7 去抖 | `notify_card.py: debounced()` |
| FR-8 安装配置 | `install.sh` |
| NFR-1 不影响主流程 | `notify_card.py` 全量异常捕获 |
| NFR-3 凭证安全 | `install.sh`（chmod 600）、不入库 |
| NFR-5 跨平台 | `session_scanner.py: proc_cwd()` |
| NFR-8 日志 | `bridge_server.py: log()` |

---

## 14. 配置项总表

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `FEISHU_MODE` | `webhook` | `webhook` / `app` |
| `FEISHU_WEBHOOK` | — | 模式 A 必填 |
| `FEISHU_BTN_LINK` | 空 | 模式 A 的按钮跳转链接 |
| `FEISHU_APP_ID` | — | 模式 B 必填 |
| `FEISHU_APP_SECRET` | — | 模式 B 必填 |
| `FEISHU_RECEIVE_ID_TYPE` | `chat_id` | `chat_id` / `open_id` / `user_id` / `email` |
| `FEISHU_RECEIVE_ID` | — | 模式 B 必填，如 `oc_xxx` |
| `FEISHU_DEBOUNCE_SEC` | `45` | 去抖秒数，`0` = 每轮都发 |
| `FEISHU_TURNS` | `1` | 展示最近几轮问答，`0` = 全部 |
| `FEISHU_MAX_CHARS` | `1200` | AI 输出最大字符数 |
| `CLAUDE_TMUX_PANE` | 自动探测 | 强制指定注入的 pane |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Claude 配置目录 |
