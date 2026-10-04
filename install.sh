#!/usr/bin/env bash
# Claude Code × 飞书交互卡片 一键安装
set -euo pipefail

INSTALL_DIR="${HOME}/.claude"
STATE_DIR="${HOME}/.claude/feishu-bridge"
ENV_FILE="${INSTALL_DIR}/feishu.env"

# Windows 上 python3 常是 Microsoft Store 假 stub，探测可用的解释器
PYBIN=python3
if ! python3 -c "print(1)" >/dev/null 2>&1; then
  if command -v py >/dev/null 2>&1; then
    PYBIN="py -3"
  else
    echo "未找到可用的 Python（试过 python3 和 py）"; exit 1
  fi
fi

echo "=========================================="
echo " Claude Code → 飞书交互卡片  安装向导"
echo "=========================================="
echo
echo "两种模式："
echo "  1) webhook  群自定义机器人    —— 5 分钟搞定，但【按钮点击无回调】"
echo "  2) app      企业自建应用机器人 —— 支持真·交互按钮（继续/自查/提交/结束）"
echo
read -r -p "选择模式 [1/2，默认 2]: " MODE_CHOICE
MODE_CHOICE="${MODE_CHOICE:-2}"

if [[ "$MODE_CHOICE" == "1" ]]; then
  FEISHU_MODE="webhook"
  read -r -p "粘贴群机器人 Webhook 地址: " FEISHU_WEBHOOK
  [[ -z "$FEISHU_WEBHOOK" ]] && { echo "Webhook 不能为空"; exit 1; }
  read -r -p "卡片按钮跳转链接（可留空）: " FEISHU_BTN_LINK || FEISHU_BTN_LINK=""
else
  FEISHU_MODE="app"
  read -r -p "App ID (cli_xxx): " FEISHU_APP_ID
  read -r -p "App Secret: " FEISHU_APP_SECRET
  [[ -z "$FEISHU_APP_ID" || -z "$FEISHU_APP_SECRET" ]] && { echo "App ID / Secret 不能为空"; exit 1; }
  read -r -p "接收者类型 [chat_id/open_id，默认 chat_id]: " FEISHU_RECEIVE_ID_TYPE
  FEISHU_RECEIVE_ID_TYPE="${FEISHU_RECEIVE_ID_TYPE:-chat_id}"
  read -r -p "接收者 ID (oc_xxx / ou_xxx): " FEISHU_RECEIVE_ID
  [[ -z "$FEISHU_RECEIVE_ID" ]] && { echo "接收者 ID 不能为空"; exit 1; }
fi

read -r -p "同一会话去抖秒数（默认 45，0=每轮都发）: " DEBOUNCE
DEBOUNCE="${DEBOUNCE:-45}"

echo
echo "卡片里要展示多少轮「用户提问 + AI 输出」？"
echo "  1 = 只展示最近结束的这一轮（默认）"
echo "  3 = 最近 3 轮"
echo "  0 = 整个会话的全部轮次"
read -r -p "轮数 [默认 1]: " TURNS
TURNS="${TURNS:-1}"

# ---------- 1. 拷贝脚本 ----------
mkdir -p "$INSTALL_DIR" "$STATE_DIR"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cp "$SCRIPT_DIR/notify_card.py"  "$INSTALL_DIR/notify_card.py"
cp "$SCRIPT_DIR/bridge_server.py" "$INSTALL_DIR/bridge_server.py"
cp "$SCRIPT_DIR/session_scanner.py" "$INSTALL_DIR/session_scanner.py"
chmod +x "$INSTALL_DIR/notify_card.py" "$INSTALL_DIR/bridge_server.py" "$INSTALL_DIR/session_scanner.py"

# ---------- 2. 写环境变量 ----------
cat > "$ENV_FILE" <<EOF
# Claude Code → 飞书 通知配置
export FEISHU_MODE="${FEISHU_MODE}"
export FEISHU_DEBOUNCE_SEC="${DEBOUNCE}"
export FEISHU_TURNS="${TURNS}"
EOF

if [[ "$FEISHU_MODE" == "webhook" ]]; then
  cat >> "$ENV_FILE" <<EOF
export FEISHU_WEBHOOK="${FEISHU_WEBHOOK}"
export FEISHU_BTN_LINK="${FEISHU_BTN_LINK:-}"
EOF
else
  cat >> "$ENV_FILE" <<EOF
export FEISHU_APP_ID="${FEISHU_APP_ID}"
export FEISHU_APP_SECRET="${FEISHU_APP_SECRET}"
export FEISHU_RECEIVE_ID_TYPE="${FEISHU_RECEIVE_ID_TYPE}"
export FEISHU_RECEIVE_ID="${FEISHU_RECEIVE_ID}"
EOF
fi
chmod 600 "$ENV_FILE"

# ---------- 3. 合并 hook 到 settings.json ----------
SETTINGS="${INSTALL_DIR}/settings.json"
[[ -f "$SETTINGS" ]] || echo '{}' > "$SETTINGS"
cp "$SETTINGS" "${SETTINGS}.bak.$(date +%s)"

HOOK_CMD="bash -c 'source ${ENV_FILE} >/dev/null 2>&1; ${PYBIN} ${INSTALL_DIR}/notify_card.py'"

$PYBIN - "$SETTINGS" "$HOOK_CMD" <<'PY'
import json, sys
settings_path, hook_cmd = sys.argv[1], sys.argv[2]
with open(settings_path, "r", encoding="utf-8") as f:
    cfg = json.load(f)

entry = {"hooks": [{"type": "command", "command": hook_cmd, "async": True, "timeout": 20}]}
cfg.setdefault("hooks", {}).setdefault("Stop", [])

# 去重：同目录下已有 claude 飞书通知就替换
existed = False
for group in cfg["hooks"]["Stop"]:
    seen = False
    for h in group.get("hooks", []):
        if "notify_card.py" in h.get("command", ""):
            h["command"] = hook_cmd
            h["async"] = True
            h["timeout"] = 20
            existed = seen = True
    if seen:
        break
if not existed:
    cfg["hooks"]["Stop"].append(entry)

with open(settings_path, "w", encoding="utf-8") as f:
    json.dump(cfg, f, ensure_ascii=False, indent=2)
print("settings.json 已更新")
PY

echo
echo "✅ 安装完成"
echo "   环境变量: $ENV_FILE"
echo "   Hook 配置: $SETTINGS (Stop)"
echo
echo "测试：在 Claude Code 里随便问一句，飞书应收到卡片。"

if [[ "$FEISHU_MODE" == "app" ]]; then
  echo
  echo "下一步：启动回调桥接服务（否则按钮点了没反应、命令也没人回）"
  echo "  pip install lark-oapi"
  echo "  source $ENV_FILE"
  echo "  nohup python3 $INSTALL_DIR/bridge_server.py >> $STATE_DIR/bridge.log 2>&1 &"
  echo
  echo "开放平台还需完成："
  echo "  1) 应用能力开启「机器人」"
  echo "  2) 权限：im:message、im:message.p2p_msg:readonly、im:message.group_at_msg:readonly"
  echo "  3) 事件配置：长连接 + 添加事件「接收消息 im.message.receive_v1」"
  echo "  4) 回调配置：添加「卡片回传交互 card.action.trigger」"
  echo "  5) 创建版本并【发布】—— 不发布不生效"
  echo
  echo "发布后，在飞书里对机器人发 /list 即可查询所有 Claude Code 会话。"
fi
