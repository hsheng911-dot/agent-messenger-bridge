# Spec Delta

## Purpose

提供 agent-messenger-bridge 的本地交互式安装向导:分步探测运行环境、引导用户完成飞书凭证授权与接收者选择、写入配置与 hook,并拉起桥接服务完成端到端验证。

## ADDED Requirements

### Requirement: 运行时环境探测
向导启动时 SHALL 探测 Node 版本(要求 >= 18)、tmux 与 claude 可执行文件,并逐项报告结果。Node 版本不满足时 SHALL 终止并给出升级提示;tmux 缺失仅 SHALL 警告(按钮指令将走 claude -p 兜底),不阻断安装。

#### Scenario: Node 版本过低
- **WHEN** 检测到 Node 版本低于 18
- **THEN** 向导打印升级提示并以非零码退出,不写入任何配置

#### Scenario: 缺少 tmux
- **WHEN** 未检测到 tmux
- **THEN** 向导警告按钮指令将使用 claude -p 兜底,继续安装流程

### Requirement: 模式选择
向导 SHALL 提示用户在 webhook(群自定义机器人)与 app(企业自建应用)两种模式间选择,并说明两者按钮回调能力的差别。

#### Scenario: 选择模式
- **WHEN** 用户在提示后选择 1 或 2(或直接回车取默认)
- **THEN** 向导进入对应模式的凭证收集分支

### Requirement: 凭证现场验证
向导 SHALL 在写配置前现场验证凭证:webhook 模式向该地址发送一条测试消息;app 模式用 App ID/Secret 请求 tenant_access_token。验证失败时 SHALL 显示错误并允许重试或放弃,不得把未验证的凭证写入配置。

#### Scenario: webhook 验证失败
- **WHEN** 测试消息被飞书拒绝(非 0 返回码或网络错误)
- **THEN** 向导显示返回内容并重新提示粘贴 Webhook,配置文件未被修改

#### Scenario: app 凭证有效
- **WHEN** App ID/Secret 成功换取 tenant_access_token
- **THEN** 向导确认凭证有效并继续下一步

### Requirement: 接收者列表选择
app 模式下,凭证验证通过后向导 SHALL 调用 `im/v1/chats` 拉取机器人所在群列表,渲染编号菜单供用户选择接收者;同时 SHALL 保留手动输入 chat_id/open_id 的入口。列表为空或拉取失败时 SHALL 提示并转入手动输入。

#### Scenario: 从列表选择
- **WHEN** 接口返回 2 个及以上群
- **THEN** 向导展示编号列表,用户输入序号后该群 chat_id 被选为接收者

#### Scenario: 列表为空
- **WHEN** 机器人未加入任何群或接口失败
- **THEN** 向导提示原因并允许手动粘贴接收者 ID

### Requirement: 选项收集
向导 SHALL 依次询问去抖秒数(默认 45)与卡片展示轮数(默认 1,0 为整个会话),直接回车即取默认值。

#### Scenario: 全部回车
- **WHEN** 用户对所有选项直接回车
- **THEN** 配置使用全部默认值(模式必填项除外)

### Requirement: Hook 写入 settings.json
向导 SHALL 把 Stop hook(命令为 `node <安装目录>/notify_card.js`)合并进 `~/.claude/settings.json`,写入前 SHALL 备份原文件;重复安装时 SHALL 按 notify_card 脚本标识替换既有条目而不是追加重复项。

#### Scenario: 全新安装
- **WHEN** settings.json 中没有本工具的 hook
- **THEN** 追加一条 Stop hook,原有其他配置保持不变

#### Scenario: 重复安装
- **WHEN** settings.json 中已存在本工具的 hook
- **THEN** 原条目被替换为新的 hook 命令,不产生重复条目

### Requirement: 配置落盘
向导 SHALL 把模式、凭证、接收者与选项写入 `~/.claude/feishu-card.json`,并在支持的系统上将文件权限限制为仅当前用户可读。

#### Scenario: 写入配置
- **WHEN** 向导完成全部步骤
- **THEN** `~/.claude/feishu-card.json` 包含所选模式对应的完整配置字段

### Requirement: 桥接服务拉起与端到端验证
app 模式下向导 SHALL 自动安装运行时依赖、以后台方式启动 bridge、并提示用户确认收到测试卡片;webhook 模式 SHALL 在凭证验证阶段即完成测试发送,无需 bridge。

#### Scenario: app 模式完成安装
- **WHEN** 用户完成 app 模式向导
- **THEN** 依赖安装完成、bridge 进程启动且日志显示长连接已建立,用户在飞书收到测试卡片
