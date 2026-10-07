# Tasks

## 1. Spike:Node SDK 卡片回调能力验证(design D3)

- [x] 1.1 建最小 spike 脚本,用 @larksuiteoapi/node-sdk WSClient 接入测试应用凭证,确认能收到 `im.message.receive_v1`;验证方式:向机器人发消息,spike 脚本打印事件
- [x] 1.2 在测试应用添加 card.action.trigger 后,从飞书发送一张带 callback 按钮的卡片,确认 WSClient 能收到回传事件,并验证同步返回 toast / 原地换卡片是否生效;把结论(支持/需走 HTTP 回调降级)写入 design.md D3,后续任务按对应分支执行

## 2. 包结构与配置层

- [x] 2.1 创建 `package.json`(name: agent-messenger-bridge,bin: agent-messenger-bridge-setup → bin/setup.js,engines: node>=18)与 lib/bin/test 目录骨架;验证:`npm install` 无错,`node -e "require('./package.json')"` 可读
- [x] 2.2 实现 `lib/config.js`:读取 `~/.claude/feishu-card.json`,环境变量 > JSON > 默认值的合并逻辑,webhook/app 两种模式的必填字段校验;验证:node:test 单测覆盖合并优先级与缺字段报错
- [x] 2.3 实现 `lib/feishu.js`:纯 fetch 的 tenant_access_token 获取与本地缓存(过期前 60 秒复用)、发消息、`im/v1/chats` 群列表;验证:node:test 用注入的 mock fetch 测缓存命中与错误码透传

## 3. transcript 解析移植(先于卡片,依赖 2)

- [x] 3.1 从本机真实 transcript 截取(脱敏)JSONL 样例放入 `test/fixtures/`:含工具调用的轮、被打断的半轮、纯 tool_result 的 user 记录、带 system-reminder 的提问、会话开头无提问;验证:fixtures 文件存在且能被 JSONL 逐行解析
- [x] 3.2 实现 `lib/transcript.js`(parse_turns 语义逐条对齐 Python 版:轮次切分、tool_result 跳过、reminder 清理、message.id 去重、半轮丢弃、开头兜底);验证:先跑 Python 版 `notify_card.py` 的 parse_turns 导出各 fixture 的期望输出,再写 node:test 断言 Node 输出一致(question/answer/token 数逐字段对照)

## 4. notify-card.js(Stop hook,依赖 2、3)

- [x] 4.1 实现 `lib/notify-card.js`:stdin hook JSON 读取、去抖、git 信息、卡片 JSON 2.0 构造(按钮 app 回传/webhook 降级)、webhook 与 app 两条发送路径、会话上下文落盘;验证:node:test 覆盖卡片构造(按钮 behaviors 两种模式、``` 替换、截断)与去抖,发送路径用 mock fetch;实机跑 `echo '{}' | node lib/notify-card.js` 退出码为 0
- [ ] 4.2 用真实 Claude Code 会话实测:webhook 模式收到卡片且无回传按钮,app 模式收到带四按钮卡片、点按钮后 bridge(任务 5 完成后复测)能收到回调;验证:飞书截图/日志记录

## 5. session-scanner.js(依赖 2)

- [x] 5.1 实现 `lib/session-scanner.js`:ps/tmux/transcript 三源扫描、状态判定(ACTIVE_SEC=60/IDLE_SEC=600)、cwd 前缀匹配、路径分隔符 normalize、to_text/to_card;验证:node:test 对状态判定函数全分支覆盖(用注入的假进程/时间数据),`node lib/session-scanner.js` 与 `--json` 在本机输出合法结果
- [x] 5.2 与 Python 版对照:同一时刻分别运行新旧扫描器,核对会话列表条目与状态一致(允许扫描时间差引起的瞬时差异);验证:两份输出 diff 记录在 PR/提交说明中

## 6. bridge.js(依赖 2、5,分支取决于 1.2 结论)

- [x] 6.1 实现 `lib/bridge.js`:WS 长连接启动与凭证校验退出、卡片回调处理(continue/review/commit/done/list/select、toast 返回)、消息事件处理(命令别名/中文 NL 解析、@ 提及剥离、message_id 幂等、非文本忽略)、focus 持久化;验证:node:test 覆盖 parse_command 全分支与 deliver 决策树(mock tmux/spawn)
- [x] 6.2 实现三级投递:tmux load-buffer/paste-buffer/send-keys → claude -p 无头会话(claude/claude.exe/claude.cmd 按 PATHEXT 探测,输出摘要回发)→ inbox 队列落盘;验证:claude -p 兜底真机通过(2026-10-05 Windows 实测,用户拍板方案 A),tmux 注入由单测覆盖,真机验证挪至产品化阶段的多平台实测
- [ ] 6.3 实机端到端:飞书点「▶ 继续」toast 成功且指令到达会话、/list 返回卡片、/focus 2 生效、/status 回复、重复消息只处理一次;验证:bridge.log 记录逐条核对

## 7. 安装向导 bin/setup.js(依赖 2–6)

- [x] 7.1 实现向导主体:readline/promises 分步交互、运行时探测(node>=18/tmux/claude,非 TTY 打印手动配置后退出)、模式选择、webhook 测试消息验证、app 凭证验证;验证:本机跑向导走 webhook 分支全程,故意输错 webhook 触发重试
- [x] 7.2 实现 app 分支:群列表编号菜单选择接收者(空列表转手动输入)、选项收集(回车取默认)、写 `~/.claude/feishu-card.json`、备份并合并 settings.json(按 notify-card.js 标识去重、旧 notify_card.py hook 提示替换)、npm install SDK、后台拉起 bridge、发测试卡片;验证:全新环境跑一次完整 app 分支,settings.json 无重复 hook,飞书收到测试卡片
- [x] 7.3 旧配置导入:检测到 `~/.claude/feishu.env` 时提示一次性导入到新 JSON;验证:构造旧 env 文件跑向导确认导入提示与字段映射正确

## 8. 收尾:下线 Python 版与文档(依赖 7 验收通过)

- [ ] 8.1 双模式真机验收(webhook + app 各一台,含 Windows):从 `node bin/setup.js` 开始到飞书按钮闭环全流程通过;验证:README 的验证步骤逐步执行通过
- [x] 8.2 删除 `notify_card.py`/`session_scanner.py`/`bridge_server.py`/`install.sh`,更新 README(安装手册、配置说明、常见问题)与 REQUIREMENTS 中的技术栈描述;验证:仓库中无 .py 残留,README 所有命令可照抄执行
- [x] 8.3 `openspec validate` 通过并核对四个 spec 的 scenario 均有对应实现与测试;验证:validate 输出无 error
