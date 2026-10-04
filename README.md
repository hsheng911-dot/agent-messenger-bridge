# Claude Code × 飞书交互卡片

> 📋 需求规格说明见 [`REQUIREMENTS.md`](REQUIREMENTS.md)（背景、功能需求 FR-1~FR-8、非功能需求、验收标准、风险与未来规划）。
> 本文档是**安装与使用手册**。

Claude Code 每轮任务结束（`Stop` hook）自动往飞书推一张卡片；在飞书点「继续 / 自查 / 提交 / 结束」，指令直接注入正在运行的 Claude Code 会话。

```
Claude Code 结束一轮
      │  Stop hook
      ▼
notify_card.py ──► 飞书卡片（含 4 个按钮）
                        │
                   用户点按钮
                        │  card.action.trigger（长连接）
                        ▼
                 bridge_server.py
                        │
              tmux send-keys / 落盘队列
                        ▼
                  Claude Code 继续执行
```

---

## ⚠️ 先看这里：两种模式的能力差别

| | 模式 A：群自定义机器人（Webhook） | 模式 B：企业自建应用机器人 |
|---|---|---|
| 配置成本 | 5 分钟，群里加个机器人 | 15 分钟，需建应用并发布 |
| 能发卡片 | ✅ | ✅ |
| **按钮点击有回调** | ❌ **不支持** | ✅ 支持 |
| 交互闭环 | 无 | 完整 |

飞书官方明确说明：**请求回调交互仅适用于通过应用发送的飞书卡片；卡片绑定自定义机器人发送时，不支持请求回调交互。**

所以：只想"完成时通知一下" → 用模式 A；想"在飞书点按钮继续" → 必须模式 B。

---

## 模式 A：群自定义机器人（快速版）

1. 飞书群 → 设置 → 群机器人 → 添加自定义机器人，复制 Webhook 地址
2. 安装：

```bash
cd claude-feishu-card
bash install.sh          # 选 1，粘贴 Webhook
```

3. 在 Claude Code 里随便说一句话，飞书收到卡片。

此模式下卡片按钮不会生效（脚本已自动省略，避免点了报错）。

---

## 模式 B：企业自建应用机器人（完整交互，推荐）

### 1. 创建应用

飞书开放平台 → 开发者后台 → **创建企业自建应用** → 添加应用能力 → **机器人**。

### 2. 配置事件与回调

- **事件与回调 → 事件配置 → 订阅方式**：选「使用长连接接收事件」→ 保存
- **事件与回调 → 回调配置 → 添加回调**：切到「卡片」页签，勾选 **卡片回传交互（`card.action.trigger`）**
- **权限管理**：开通 `im:message`（获取与发送单聊、群组消息）、`以应用的身份发消息`

### 3. 发布版本（关键，漏了不生效）

顶部「创建版本」→ 填版本号 → **保存并发布**。

### 4. 拿到凭证和会话 ID

- 凭证与基础信息 → `App ID` / `App Secret`
- 接收者 ID：群里把机器人 @ 一下，或用 API 拉群列表拿 `oc_xxx`（chat_id）；单聊用 `ou_xxx`（open_id）

### 5. 安装

```bash
cd claude-feishu-card
bash install.sh          # 选 2，依次填 App ID / Secret / chat_id / oc_xxx
```

### 6. 启动回调桥接服务

```bash
pip install lark-oapi
source ~/.claude/feishu.env
nohup python3 ~/.claude/bridge_server.py >> ~/.claude/feishu-bridge/bridge.log 2>&1 &
tail -f ~/.claude/feishu-bridge/bridge.log   # 看到 "启动飞书卡片回调桥接…" 即成功
```

> 建议把 Claude Code 跑在 `tmux` 里，这样按钮指令能直接注入当前会话：
> ```bash
> tmux new -s claude
> claude
> ```

### 7. 验证

Claude Code 里执行一个任务，飞书收到卡片 → 点「▶ 继续」→ toast 提示"已发送「continue」给 Claude" → 回到 tmux 看 Claude 是否开始继续干活。

---

## 四个按钮的含义

| 按钮 | `value.action` | 注入的指令 |
|---|---|---|
| ▶ 继续 | `continue` | 继续执行未完成部分，做完再汇报 |
| 🔍 自查 | `review` | 对本次改动做代码自查，找 bug / 边界 / 安全 / 性能 |
| 📦 提交 | `commit` | 整理成规范 git commit 并提交（不 push） |
| ✅ 结束 | `done` | 任务验收结束，输出简短总结 |

改指令直接编辑 `bridge_server.py` 里的 `ACTION_PROMPTS`。

---

## 🧭 在飞书里查询正在执行的会话

对着机器人发命令即可（单聊直接发，群里 **@机器人** 再发）。

| 命令 | 别名 | 作用 |
|---|---|---|
| `/list` | `/ls` `/sessions` `/会话` `/claude` `/ps` | 列出所有 Claude Code 会话（卡片） |
| `/focus 2` | `/f 2` `/选中 2` | 选中第 2 个会话 |
| `/status` | `/状态` | 查看当前选中的是哪个 |
| `/help` | `/帮助` | 帮助 |

懒得记命令也行，直接说中文：**「有哪些会话」「在跑什么」「查看会话」** 都会触发列表。

卡片上每个会话带一个「选中 #N」按钮，点一下就选中，之后完成卡片上的继续/自查/提交/结束都作用于它。

### 会话状态怎么判的

三个信息源交叉：进程表 `ps` + `tmux` + `~/.claude/projects/**/*.jsonl` 的修改时间。

| 状态 | 判定条件 |
|---|---|
| 🔄 执行中 | transcript 60 秒内有写入，或进程 CPU ≥ 5% |
| ⏸ 等待输入 | 进程还在，但 transcript 已停更（10 分钟内） |
| ✅ 已结束 | 无进程，或 transcript 超过 10 分钟没动 |

阈值在 `session_scanner.py` 顶部：`ACTIVE_SEC=60`、`IDLE_SEC=600`。

> 想手动看：`python3 ~/.claude/session_scanner.py`
> 输出 JSON：`python3 ~/.claude/session_scanner.py --json`

### 开启命令功能需要的额外配置

命令走的是消息事件，比卡片回调多配两项：

- **权限管理**：`im:message`、`im:message.p2p_msg:readonly`、`im:message.group_at_msg:readonly`
- **事件配置**：添加事件 **接收消息 `im.message.receive_v1`**

同样记得**发布版本**。

---

## 卡片里的「用户提问 + AI 输出」

卡片正文默认展示**最近结束的这一轮**完整问答：

```
项目 · 分支 · 时间 · 会话
⏱ 本轮耗时 5分12秒 · 🔢 Token 输入(含缓存) 860.3k · 输出 3.2k
────────────────────
🙋 用户提问
  「跑一下测试」
🤖 AI 输出
  「🔧 调用 Bash npm test … 全部通过」
────────────────────
[▶ 继续] [🔍 自查] [📦 提交] [✅ 结束]
```

问答从 Claude Code 的 `transcript_path`（JSONL）回溯解析，规则：

- 一轮 = 一条 user 消息 + 到下一轮 user 之前的所有 assistant 输出
- **工具结果（`tool_result`）不算用户提问**，会被跳过——否则提问区会被工具回显污染
- Claude Code 注入的 `<system-reminder>` / `<command-name>` 会被清理，只留你真正输入的内容
- assistant 调过的工具记成 `🔧 调用 Read /app/main.py`，和文本一起拼进该轮输出
- 最后一轮若只有提问没有回答（被打断），整轮丢弃
- **⏱ 耗时 / 🔢 Token** 对应卡片展示的轮次（默认最近 1 轮）：耗时是该轮从提问到最后一
  条输出的处理时间（多轮则为各轮之和，不含轮间空闲），Token 按该轮 assistant 消息
  的 usage 累加，输入含缓存写入/读取

### 控制展示范围

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `FEISHU_TURNS` | `1` | 展示最近几轮；`0` = 整个会话全部轮次 |
| `FEISHU_MAX_CHARS` | `1200` | AI 输出最大字符数，超出截断（提问固定 600） |

```bash
export FEISHU_TURNS=3      # 最近 3 轮
export FEISHU_TURNS=0      # 整个会话
```

安装时 `install.sh` 会问你要几轮，也可以之后直接改 `~/.claude/feishu.env`。

> 内容一律塞进 ` ``` ` 代码块渲染，且内容里的 ` ``` ` 会被替换成 `'''`，
> 避免用户/AI 输出里的 markdown 把卡片结构撑坏。

---

## 手动配置（不想跑 install.sh）

`~/.claude/settings.json`：

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bash -c 'source ~/.claude/feishu.env >/dev/null 2>&1; python3 ~/.claude/notify_card.py'",
            "async": true,
            "timeout": 20
          }
        ]
      }
    ]
  }
}
```

`~/.claude/feishu.env`：

```bash
export FEISHU_MODE=app
export FEISHU_APP_ID=cli_xxx
export FEISHU_APP_SECRET=xxx
export FEISHU_RECEIVE_ID_TYPE=chat_id
export FEISHU_RECEIVE_ID=oc_xxx
export FEISHU_DEBOUNCE_SEC=45
```

---

## 常见问题

**Q：为什么不用 `SessionEnd` 而用 `Stop`？**
`SessionEnd` 只有约 1.5 秒预算，网络请求经常发不完。`Stop` 是每轮回答结束触发，配合 `async: true` 不阻塞主流程，最贴近"任务完成"。

**Q：卡片刷屏怎么办？**
`FEISHU_DEBOUNCE_SEC` 默认 45 秒内同一会话只发一次。设 `0` 则每轮都发。

**Q：点了按钮没反应？**
按顺序排查：
1. 应用是否**发布**了版本（改配置后必须重新发布）
2. `card.action.trigger` 回调是否添加
3. `bridge_server.py` 是否在运行（`tail ~/.claude/feishu-bridge/bridge.log`）
4. 卡片是不是 Webhook 机器人发的（模式 A 不支持回调）
5. 已发送卡片的回调交互有效期是 **14 天**（卡片 JSON 2.0）

**Q：没有 tmux 怎么办？**
指令会落到 `~/.claude/feishu-bridge/inbox/*.json`，可以自己写个消费者，或把 `bridge_server.py` 里的 `deliver_to_inbox` 换成 `claude -p "<prompt>"` 起新会话。

**Q：飞书客户端版本？**
卡片 JSON 2.0 需要客户端 7.20+。老版本标题正常、正文会显示升级提示。

**Q：Webhook 别泄露**
`feishu.env` 权限已设 600，别提交进 git 仓库。

---

## 文件清单

| 文件 | 作用 |
|---|---|
| `REQUIREMENTS.md` | **需求规格说明**（背景、FR-1~FR-8、验收、风险） |
| `notify_card.py` | Stop hook 调用的卡片发送脚本 |
| `bridge_server.py` | 桥接服务：卡片回调 + 飞书命令（长连接 + tmux 注入） |
| `session_scanner.py` | 扫描正在执行的 Claude Code 会话，输出文本 / 卡片 |
| `install.sh` | 交互式安装：拷贝脚本、写 env、合并 settings.json |
| `example_card.json` | 卡片样例，可贴进卡片搭建工具预览 |
| `README.md` | 本文档 |
