# Proposal

## Why

当前实现要求用户机器同时具备 bash、可用的 Python 3、pip 装的 lark-oapi,在 Windows 上频频踩坑(python3 Store 假 stub、hook 依赖 `bash -c source`)。而 Claude Code 用户几乎人人有 Node(Claude Code 本身经 npm 分发)。整体迁移到 Node.js 后,可以做成 `agent-messenger-bridge` 包,一条命令进入安装向导,分步提示用户完成授权(现场验证凭证)与选择(拉群列表选接收者),把"快速安装"真正做快。

## What Changes

- **BREAKING**: 运行时整体从 Python 迁移到 Node.js(要求 Node >= 18,内置 fetch),包名 `agent-messenger-bridge`,先本地使用,不发布 npm
- 新增安装向导 `bin/setup.js`,分步交互:
  1. 探测运行时(node 版本、tmux、claude 可执行文件)
  2. 选模式(webhook / app)
  3. webhook:粘贴地址后现场发测试消息验证;app:App ID/Secret 现场换 tenant_access_token 验证
  4. app 模式:调 `im/v1/chats` 拉取机器人所在群列表,渲染菜单让用户"选"接收者(替代手填 oc_xxx)
  5. 选轮数/去抖等选项
  6. 写配置、合并 settings.json 的 Stop hook、自动 npm install、拉起 bridge、发测试卡片确认闭环
- **BREAKING**: 配置从 `~/.claude/feishu.env`(bash export)改为 `~/.claude/feishu-card.json`,脚本直接读 JSON,hook 命令改为 `node <路径>/notify_card.js`,不再依赖 bash
- 移植三个运行时脚本,行为与 Python 版对齐:
  - `notify_card.js`:Stop hook 发卡片(去抖、轮次展示、token/耗时统计、webhook 降级)
  - `session_scanner.js`:三源交叉会话扫描(ps + tmux + transcript mtime,阈值 ACTIVE_SEC=60 / IDLE_SEC=600)
  - `bridge_server.js`:WS 长连接,卡片回调注入指令(tmux → claude -p 兜底 → inbox 队列)、/list /focus /status 命令、focus 选中
- transcript 轮次解析(工具结果过滤、system-reminder/command 清理、message.id 去重累加 usage)抽成独立模块并配对照测试,以 Python 版为参照
- 迁移完成并验证后移除 `*.py` 与 `install.sh`;README、REQUIREMENTS 更新为 Node 版说明

## Capabilities

### New Capabilities

- `setup-wizard`: 交互式安装向导——运行时探测、模式选择、凭证现场验证、接收者列表选择、hook 写入、bridge 拉起与测试卡片
- `notification-card`: Stop hook 触发的飞书卡片发送——webhook/app 两种模式、去抖、transcript 轮次解析与展示、token/耗时统计
- `session-scanner`: Claude Code 会话扫描——进程/tmux/transcript 三源交叉、状态判定、文本与卡片两种输出
- `session-bridge`: 飞书↔Claude Code 桥接服务——卡片回调注入指令(tmux/claude -p/inbox 三级投递)、命令消息(/list /focus /status)、会话选中 focus

### Modified Capabilities

(无既有 spec,本项目 specs 为空)

## Impact

- 代码:`notify_card.py` / `session_scanner.py` / `bridge_server.py` / `install.sh` 全部由 Node 版替代,新增 `package.json`、`bin/`、`lib/`、测试目录
- 依赖:bridge 引入 `@larksuiteoapi/node-sdk`(WS 长连接);notify/session_scanner 保持零依赖(内置 fetch / child_process)
- 用户侧:`~/.claude/settings.json` 的 Stop hook 命令变更;配置文件换成 `~/.claude/feishu-card.json`;不再需要 pip install lark-oapi
- 风险:`@larksuiteoapi/node-sdk` WSClient 对 `card.action.trigger` 回调的支持需先做 spike 验证,若支持不全则退回 WSClient 收事件 + HTTP 回调模式(design 详述)
