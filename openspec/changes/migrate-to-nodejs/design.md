# Design

## Context

现有实现为三个 Python 脚本 + bash 安装脚本,行为基线见 `notify_card.py` / `bridge_server.py` / `session_scanner.py` 与 README。运行环境痛点(bash/python3 依赖、pip 装 lark-oapi、Windows 兼容补丁)见 proposal。本设计描述 Node.js 版的结构与关键决策;行为契约以 specs/ 下四个 capability 为准。

## Goals / Non-Goals

**Goals:**

- 单包结构 `agent-messenger-bridge`,本地 `node bin/setup.js` 一条命令完成安装,不发布 npm
- 三个运行时脚本行为与 Python 版逐条对齐,transcript 解析以样例对照测试锁定
- Windows / macOS / Linux 三平台可运行(现有脚本已在此目标上,Node 版不能倒退)

**Non-Goals:**

- 不改变飞书侧的配置要求(应用发布、权限、事件订阅仍需用户在开放平台操作,向导只负责提示与校验)
- 不发布到 npm registry,不做版本分发/升级机制
- 不新增 Python 版没有的功能(会话命令、按钮集合保持一致)

## Decisions

### D1. 包结构与模块划分

```
agent-messenger-bridge/
  package.json            bin: { "mlt-setup": "./bin/setup.js" }(本地用,不发 npm)
  bin/setup.js            安装向导入口
  lib/
    config.js             读写 ~/.claude/feishu-card.json + 环境变量覆盖
    feishu.js             纯 fetch 的飞书 REST 客户端(token 缓存、发消息、chats 列表)
    transcript.js         轮次解析(从 notify 中拆出,可单测)
    notify-card.js        Stop hook 主逻辑
    session-scanner.js    三源扫描 + to_text/to_card
    bridge.js             桥接服务
  test/                   node:test 样例对照测试
```

理由:transcript.js 独立是移植正确性的关键(见 D4);config.js 统一配置读取,避免三个脚本各自实现。备选方案(保持三脚本自包含单文件)被否,因为重复实现配置/HTTP 会让三处行为漂移。

### D2. 配置:`feishu-card.json` + 环境变量覆盖

所有 `FEISHU_*` 环境变量映射为 JSON 字段(`mode`、`webhook`、`app_id`、`app_secret`、`receive_id_type`、`receive_id`、`debounce_sec`、`turns`、`max_chars`、`btn_link`)。读取顺序:环境变量 > JSON > 内置默认。hook 命令因此简化为 `node <dir>/lib/notify-card.js`,无 `source`、无 bash。

备选:保留 env 文件兼容 —— 否,双格式是长期负担;迁移时向导检测到旧 `feishu.env` 可提示导入一次。

### D3. 桥接服务用 @larksuiteoapi/node-sdk 的 WSClient

**spike 结论(spike/spike-ws.js,2026-10-05 真机验证):支持,走单 SDK 方案。**

- WSClient 能收到 `card.action.trigger` 回调,且处理函数**同步返回 `{ toast: … }` 生效**(飞书端弹出 toast)
- 回调 payload 为扁平结构:`action.value` 在顶层(`data.action.value`),不是 `data.event.action.value`;`context.open_message_id / open_chat_id`、`operator.open_id` 均可直接取
- HTTP 回调降级方案作废,无需用户额外配置回调地址

notify / session-scanner 不用 SDK,保持零依赖(内置 fetch / child_process),保证 hook 最短启动路径。

### D4. transcript 解析移植与对照测试

`transcript.js` 逐条移植 `notify_card.py` 的 `parse_turns` / `_extract_text` / `_clean_user_text` 语义:

- 轮次切分、tool_result 跳过、system-reminder/command-name 清理、message.id 去重、半轮丢弃、开头无提问兜底
- 测试:从本机真实 transcript 中截取(脱敏)若干 JSONL 样例放进 `test/fixtures/`,Node 输出与 Python 版输出(question/answer/token 数)做快照对照;Python 版在迁移期保留为参照实现,验收后随迁移一并删除
- 时间解析用 `Date` 处理 ISO 时间戳(含 `Z` 后缀),与 Python `fromisoformat` 行为对齐

### D5. 进程扫描的跨平台策略

`session-scanner.js` 移植 `scan_processes` / `scan_tmux` / `scan_transcripts`:

- `ps` 调用在 Windows 上无对应物,沿用 Python 版"进程匹配不上靠 transcript 新鲜度兜底"的路径;`claude -p` 无头投递在 Windows 上本来就可用,因此 Windows 缺进程扫描只影响状态精度,不影响功能
- cwd→进程匹配逻辑(`cwd == pc` 或前缀匹配)原样保留,路径分隔符比较前统一 normalize 为 `/`
- 阈值 ACTIVE_SEC=60 / IDLE_SEC=600 保持常量,位置与 Python 版一致(文件顶部)

### D6. 向导交互

`bin/setup.js` 用 Node 内置 `readline/promises` 实现分步交互,不引入 inquirer(控制依赖,保证 `node bin/setup.js` 零安装即可跑,依赖安装放在需要 SDK 的 app 模式分支)。流程:

```
探测(node>=18/tmux/claude) → 选模式 → 凭证收集+现场验证
→ [app] 拉群列表选接收者 → 选项(去抖/轮数,回车取默认)
→ 写 feishu-card.json(权限收紧) → 备份+合并 settings.json(按 notify-card 标识去重)
→ [app] npm install SDK → 后台拉起 bridge → 发测试卡片 → 打印开放平台检查清单
```

webhook 模式验证即在收集时发测试消息;app 模式凭证验证用 `auth/v3/tenant_access_token/internal`,群列表用 `im/v1/chats?page_size=20`。

### D7. 旧文件下线顺序

迁移期 Python 与 Node 并存(互不干扰,入口不同);tasks 的收尾任务在 Node 版通过对照验收后才删除 `*.py` 与 `install.sh` 并改写 README。settings.json 去重标识从 `notify_card.py` 换成 `notify-card.js`,避免新旧 hook 并存。

## Risks / Trade-offs

- [Node SDK 不支持卡片回传回调的同步返回] → D3 的 spike 前置到第一个任务;降级方案(HTTP 回调)在向导里明确提示配置差异,spec 的按钮回调需求在降级模式下仍可满足(toast 降级为发一条文本消息)
- [transcript 解析回归导致卡片内容错乱] → D4 样例对照测试;fixtures 覆盖:含工具调用的轮、被打断的半轮、纯 tool_result 的 user 记录、带 system-reminder 的提问、0 轮多会话
- [Windows 上 `claude` 是 .cmd shim,子进程调用失败] → 沿用 Python 版思路:`shutil.which` 对应 Node 侧按 `PATHEXT` 逐一探测 `claude`/`claude.exe`/`claude.cmd`;spawn 时用 shell 语义或显式 .cmd 全路径
- [向导在非 TTY 环境(管道/CI)跑挂] → readline 在非 TTY 下读不到输入,向导启动时检测 `process.stdin.isTTY`,非交互环境打印手动配置文档链接后退出
- [双运行时并存期用户装错版本] → 向导检测到旧 `notify_card.py` hook 时提示并替换;两套去重标识不同,不会互相覆盖

## Migration Plan

1. spike 确认 SDK 能力(D3) → 2. 搭包结构 + transcript.js 对照测试 → 3. notify-card.js → 4. session-scanner.js → 5. bridge.js → 6. setup.js 向导 → 7. 真机(webhook + app 各一台)端到端验收 → 8. 删除 Python 实现与 install.sh,更新 README/REQUIREMENTS。回滚:第 7 步前任意时点可放弃,Python 版未被改动;第 8 步以 git 为准可整体还原。

## Open Questions

(无——SDK 能力不确定项已前置为 spike 任务,其两种结果都落在 D3 的既定分支内,不影响 spec 与任务拆分。)
