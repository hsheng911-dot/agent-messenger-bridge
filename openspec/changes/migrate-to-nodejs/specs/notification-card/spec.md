# Spec Delta

## Purpose

作为 Claude Code 的 Stop hook,在每轮任务结束时向飞书发送交互卡片,展示最近的用户提问与 AI 输出,并在 app 模式下提供可回调的操作按钮。

## ADDED Requirements

### Requirement: Hook 输入容错
脚本 SHALL 从 stdin 读取 Claude Code 传入的 hook JSON;输入为空或非法时 SHALL 按空对象处理并以退出码 0 结束,任何通知失败都不得使 hook 非零退出或阻断 Claude Code。

#### Scenario: stdin 为空
- **WHEN** hook 以空 stdin 被调用
- **THEN** 脚本以退出码 0 结束,不抛出异常

#### Scenario: 发送失败
- **WHEN** 飞书接口返回错误或网络不可达
- **THEN** 错误被记录到 stderr,脚本仍以退出码 0 结束

### Requirement: 配置读取
脚本 SHALL 从 `~/.claude/feishu-card.json` 读取模式、凭证与选项;真实环境变量存在时 SHALL 优先于配置文件(便于临时覆盖)。

#### Scenario: 配置文件缺失
- **WHEN** 配置文件不存在
- **THEN** 脚本按 webhook 模式处理并因缺少凭证记录错误后退出 0,不崩溃

### Requirement: Webhook 模式发送
webhook 模式 SHALL 通过群机器人 Webhook 发送卡片 JSON 2.0,按钮降级为 open_url 跳转(未配置链接时省略),并附"自定义机器人不支持回调"提示。

#### Scenario: 发送成功
- **WHEN** Webhook 返回码为 0
- **THEN** 飞书群收到不含回传按钮的卡片

### Requirement: App 模式发送
app 模式 SHALL 先获取 tenant_access_token(本地缓存,过期前 60 秒内复用),再经 `im/v1/messages` 按配置的 receive_id_type 发送卡片,卡片包含 continue/review/commit/done 四个回传按钮(值为 action + session_id)。

#### Scenario: token 缓存命中
- **WHEN** 缓存的 tenant_access_token 距过期超过 60 秒
- **THEN** 不再请求鉴权接口,直接使用缓存 token 发送

### Requirement: 会话级去抖
脚本 SHALL 对同一 session_id 在去抖窗口(默认 45 秒,配置为 0 时禁用)内跳过重复发送。

#### Scenario: 窗口内重复触发
- **WHEN** 同一会话在 45 秒内第二次触发 Stop hook
- **THEN** 本次不发送卡片,记录去抖日志

#### Scenario: 去抖禁用
- **WHEN** 去抖配置为 0
- **THEN** 每轮结束都发送卡片

### Requirement: 轮次解析
脚本 SHALL 从 transcript JSONL 按原始顺序解析轮次:一轮 = 一条真实用户消息及其后所有 assistant 输出;tool_result 不视为用户提问;`<system-reminder>` 与 `<command-name>` 注入内容被清除;assistant usage 按 message.id 去重累加;最后一条没有 AI 输出的半轮被丢弃;会话开头无提问的输出归入"（会话开头的输出）"轮。

#### Scenario: 工具结果不污染提问
- **WHEN** transcript 中 user 消息的 content 仅含 tool_result
- **THEN** 该条不产生新轮次

#### Scenario: 打断的半轮
- **WHEN** 最后一轮只有用户提问、没有任何 assistant 输出
- **THEN** 该轮被丢弃,不展示在卡片上

#### Scenario: usage 去重
- **WHEN** 同一 assistant message.id 出现多次
- **THEN** token 用量只累计一次

#### Scenario: 流式增量落盘的正文不丢失
- **WHEN** 同一 assistant message.id 先落盘只有工具调用、后续落盘才带正文
- **THEN** 卡片的 AI 输出包含正文与工具调用摘要,且 token 用量只计一次

### Requirement: 提问图片展示
提问内容中的本地图片标记(`[Image: source: 路径]`)SHALL 被提取:图片上传飞书(im/v1/images,最多 2 张、单张 ≤10MB、文件需存在)后以卡片 img 元素展示,提问文字部分不再包含标记;上传失败或不符合条件的图片 SHALL 降级为文字说明并保留原图路径;webhook 模式 SHALL 跳过上传。

#### Scenario: 图片提问
- **WHEN** app 模式下用户提问包含一张本地图片
- **THEN** 卡片的提问区展示文字与图片(image_key 元素),不再出现路径标记

#### Scenario: 上传失败降级
- **WHEN** 图片不存在或上传失败
- **THEN** 卡片以文字说明图片未能上传并保留原图路径,不影响卡片发送

### Requirement: AI 输出取最后一段文字
每轮的「AI 输出」SHALL 展示该轮最后一段面向用户的文字回复(不含工具调用流水与中间输出);该轮没有任何文字输出时按空展示。流式重复落盘的同一消息以最新内容为准。

#### Scenario: 多段输出取末段
- **WHEN** 一轮中 assistant 先有中间说明、调用了工具、最后给出结论
- **THEN** 卡片「AI 输出」只展示最后的结论文字

### Requirement: 展示范围与截断
脚本 SHALL 按"展示轮数"配置(默认 1,0 为整个会话)从末尾取轮次展示;AI 输出超过最大字符数(默认 1200)时截断,提问固定 600;内容置入代码块且内容中的 ``` 被替换,防止撑坏卡片。

#### Scenario: 展示最近 3 轮
- **WHEN** 展示轮数配置为 3 且会话已有 5 轮
- **THEN** 卡片只展示最后 3 轮,并标注"第 i/3 轮"

### Requirement: 耗时与 Token 统计
脚本 SHALL 统计所展示轮次的处理耗时(各轮提问至该轮最后一条输出之和,不含轮间空闲)与 token 消耗(输入含缓存写入/读取),并标注"本轮/最近 N 轮合计/整个会话"。

#### Scenario: 单轮统计
- **WHEN** 展示 1 轮且该轮有起止时间与 usage
- **THEN** 卡片显示该轮耗时与输入/输出 token 数

### Requirement: 会话上下文落盘
脚本 SHALL 把 session_id、项目 cwd 与时间写入状态目录,供桥接服务回调时定位目标会话。

#### Scenario: 上下文文件生成
- **WHEN** 一次 hook 执行完成(无论发送成败)
- **THEN** 状态目录中存在以该会话命名的上下文 JSON 文件
