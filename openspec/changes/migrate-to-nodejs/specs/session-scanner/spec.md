# Spec Delta

## Purpose

扫描本机上正在执行或挂起的 Claude Code 会话,交叉进程、tmux 与 transcript 三个信息源给出状态判定,供桥接服务定位会话,也可独立以文本/JSON/卡片形式输出。

## ADDED Requirements

### Requirement: 三源交叉扫描
扫描器 SHALL 汇总三个信息源:进程表(ps)中的 claude 进程、tmux 中跑着 claude 的 pane(cwd→pane 映射)、以及 `~/.claude/projects/**/*.jsonl` transcript(按修改时间排序),并支持通过 CLAUDE_CONFIG_DIR 定位 Claude 目录。

#### Scenario: 正常扫描
- **WHEN** 本机有正在运行的 Claude Code 会话
- **THEN** 扫描结果包含对应会话的 cwd、项目名、最近提问与 tmux pane 信息(如有)

### Requirement: 状态判定
扫描器 SHALL 按以下规则判定会话状态:transcript 超过 IDLE_SEC(600 秒)未更新为"已结束";进程存活且 transcript 在 ACTIVE_SEC(60 秒)内有写入或 CPU >= 5% 为"执行中";进程存活但停更为"等待输入";无进程但 transcript 刚写入过仍判"执行中"。

#### Scenario: 执行中
- **WHEN** transcript 在 60 秒内有写入且进程存活
- **THEN** 该会话状态为"🔄 执行中"

#### Scenario: 已结束
- **WHEN** transcript 超过 600 秒未更新
- **THEN** 无论进程是否存在,状态均为"✅ 已结束"

### Requirement: 排除子 agent transcript
扫描器 SHALL 跳过子 agent 的 transcript(subagents 子目录及 agent-* 命名的文件),会话列表只包含用户会话。

#### Scenario: 子 agent 不入列表
- **WHEN** transcript 目录中存在 subagents 子目录或 agent-* 命名的文件
- **THEN** 这些文件不出现在会话列表中

### Requirement: 进程无 transcript 兜底
对有 claude 进程但未匹配到 transcript 的目录(如刚启动尚未落盘),扫描器 SHALL 生成一条"执行中"的会话记录。

#### Scenario: 刚启动的会话
- **WHEN** claude 进程存在但其目录下没有对应 transcript
- **THEN** 扫描结果中该目录以"执行中"状态出现

### Requirement: 多形态输出
扫描器 SHALL 支持三种输出:CLI 文本表格、`--json` 结构化输出、以及供桥接服务使用的卡片 JSON 2.0(含每会话"选中 #N"回传按钮,执行中的会话排在前面)。

#### Scenario: JSON 输出
- **WHEN** 以 `--json` 参数独立运行
- **THEN** 输出包含 total/running/idle 计数与会话数组的合法 JSON

#### Scenario: 卡片输出
- **WHEN** 桥接服务请求会话列表卡片
- **THEN** 返回的卡片为每个会话(最多前 5 个)提供"选中 #N"回传按钮
