# Spec Delta

## Purpose

常驻的飞书↔Claude Code 桥接服务:经长连接接收卡片按钮回调与命令消息,把用户指令注入运行中的 Claude Code 会话,并支持查询与选中会话。

## ADDED Requirements

### Requirement: 长连接启动
桥接服务 SHALL 经事件长连接(WebSocket)接入飞书,同时处理卡片回传交互(card.action.trigger)与消息事件(im.message.receive_v1);配置中缺少 App ID/Secret 时 SHALL 打印错误并以非零码退出。

#### Scenario: 缺少凭证启动
- **WHEN** 未配置 App ID/Secret 就启动桥接
- **THEN** 服务打印配置指引并以非零码退出

### Requirement: 卡片按钮回调
桥接服务 SHALL 处理卡片按钮的 action 值:continue/review/commit/done 按预设指令表注入目标会话;list 将当前卡片原地替换为会话列表卡片;select 按 value 中的会话写入 focus 并返回成功 toast;未知 action 返回错误 toast;处理异常返回失败 toast。

#### Scenario: 点击继续
- **WHEN** 用户点击「▶ 继续」按钮
- **THEN** 对应指令被投递到目标会话,飞书弹出成功 toast 并说明投递方式

#### Scenario: 选中会话后确认对象
- **WHEN** 用户点击「选中 #N」且目标会话存在
- **THEN** 除成功 toast 外,机器人再发送一条消息,内容包含选中序号、项目名、目录,以及用法提示(可输入提示词提交执行、可输入「停止」终止会话)

#### Scenario: 列表仅显示执行中会话
- **WHEN** 通过 /list 或「全部会话」查询会话(不带参数)
- **THEN** 列表只包含状态为「执行中」的会话,每个会话显示最近一次提问;没有执行中会话时以文本/toast 提示

#### Scenario: 列表带数量参数
- **WHEN** 用户发送 /list 5
- **THEN** 列表显示最近 5 个会话(不限状态),按最近更新排序

#### Scenario: 卡片内查询会话
- **WHEN** 用户点击「🧭 全部会话」按钮
- **THEN** 该卡片被替换为仅含执行中会话的列表卡片;没有执行中会话时以 toast 提示

### Requirement: 三级指令投递
桥接服务 SHALL 按以下顺序投递指令:目标会话的 tmux pane(tmux send-keys 注入)→ 无 tmux 时在目标 cwd 启动 `claude -p` 无头会话执行并把输出摘要回发飞书 → 均不可用时落盘到 inbox 队列文件。目标会话按 value 中的 session_id/cwd 匹配,匹配不到时使用当前 focus。

#### Scenario: tmux 注入成功
- **WHEN** 目标会话存在于 tmux pane 中
- **THEN** 指令经 tmux 缓冲区粘贴注入,不再走后续兜底

#### Scenario: Windows 无 tmux
- **WHEN** 目标会话不在 tmux 中但其 cwd 存在
- **THEN** 在该目录启动 claude -p 执行指令,完成后把输出摘要回发飞书

#### Scenario: 完全不可投递
- **WHEN** 找不到 tmux pane 且目标 cwd 不存在
- **THEN** 指令被写入 inbox 队列文件并提示用户

### Requirement: 命令消息处理
桥接服务 SHALL 处理文本命令:/list(/ls /会话 等别名)回复会话列表卡片、/focus <序号> 选中会话、/status 回复当前选中会话、/help 显示帮助;支持中文自然语言触发列表("有哪些会话"等);群聊消息 SHALL 先剥离 @ 提及;按 message_id 幂等去重;非文本消息与无法识别的命令静默忽略(未知斜杠命令除外,回复帮助)。

#### Scenario: 列表命令
- **WHEN** 用户向机器人发送 /list
- **THEN** 机器人以回复形式发送会话列表卡片,仅包含执行中的会话

#### Scenario: 选中会话
- **WHEN** 用户发送 /focus 2 且列表中有至少 2 个会话
- **THEN** 第 2 个会话被写入 focus,机器人回复确认信息

#### Scenario: 消息重推幂等
- **WHEN** 飞书重推同一条 message_id 的消息
- **THEN** 第二次不产生任何回复

### Requirement: 提示词转发与会话终止
已选中会话(focus 存在)时,非命令的文本消息 SHALL 作为提示词转发到选中会话(投递链与按钮指令一致:tmux → claude -p → inbox),并回发投递结果说明;消息「停止」或 /stop SHALL 终止选中会话(tmux 中发送 Ctrl+C,否则结束会话进程),无法终止时说明原因;未选中会话时非命令文本 SHALL 保持静默。

#### Scenario: 提示词转发
- **WHEN** 已 /focus 选中会话,用户发送一条非命令文本(如"帮我修复测试")
- **THEN** 提示词经投递链提交到选中会话执行,机器人回复投递结果说明

#### Scenario: 终止会话
- **WHEN** 已选中会话,用户发送「停止」或 /stop
- **THEN** 会话被终止(tmux 场景发送 Ctrl+C;无 tmux 场景优先结束该会话 Stop hook 记录的 claude 祖先进程任务树,其次结束会话进程),机器人回复终止结果;无法终止时回复原因

#### Scenario: 未选中时静默
- **WHEN** 未选中任何会话,用户发送非命令文本
- **THEN** 不产生任何回复与投递

### Requirement: 会话改动 diff 查询
选中会话后,用户发送 /diff SHALL 返回该会话目录的改动清单卡片:文件列表(最多 10 个)标注修改/新增与增删行数(已跟踪文件经 git diff HEAD --numstat,未跟踪文件经 git status --porcelain 标为新增);每个文件附「详情」按钮,点击 SHALL 把该文件的具体 diff(git diff HEAD -- file,未跟踪文件展示全文,超长截断)发送到会话。裸词 diff 不作为命令(走提示词转发)。无选中会话、目录无改动时 SHALL 分别提示。

#### Scenario: 查看改动清单
- **WHEN** 已选中会话,用户发送 /diff
- **THEN** 机器人回复改动清单卡片,每个文件带「详情」按钮

#### Scenario: 查看单文件 diff
- **WHEN** 用户点击某文件的「详情」按钮
- **THEN** 该文件的具体 diff 以代码块形式发送到会话

#### Scenario: 无改动或未选中
- **WHEN** 用户发送 diff 但未选中会话,或选中会话的目录没有改动
- **THEN** 分别回复"请先选中会话"或"工作区干净"的提示

### Requirement: Focus 状态管理
桥接服务 SHALL 把当前选中会话(session_id、cwd、项目名、选中时间)持久化到状态目录,并在按钮回调与命令处理中按 session_id/cwd 优先、focus 兜底的顺序解析目标会话。

#### Scenario: focus 兜底
- **WHEN** 按钮回调未携带 session_id 且无法按 cwd 匹配,但此前已 /focus 选中过会话
- **THEN** 指令投递到 focus 记录的会话
