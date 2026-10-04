#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
飞书 ↔ Claude Code 桥接服务（长连接模式，无需公网域名 / 内网穿透）

两件事：
  1. 卡片按钮回调（card.action.trigger）
     用户点「继续 / 自查 / 提交 / 结束 / 选中 #N」→ 指令注入运行中的会话
  2. 命令消息（im.message.receive_v1）
     飞书里发 /list、/focus 2、/status → 查询当前所有 Claude Code 会话

前置条件（飞书开放平台，企业自建应用）：
  1. 应用能力里开启「机器人」
  2. 权限管理开通：
       - im:message（获取与发送单聊、群组消息）
       - im:message.p2p_msg:readonly（读取用户发给机器人的单聊消息）
       - im:message.group_at_msg:readonly（接收群聊中 @机器人 消息）
  3. 事件与回调 → 事件配置 → 订阅方式：使用长连接接收事件
     并添加事件「接收消息 im.message.receive_v1」
  4. 事件与回调 → 回调配置 → 添加「卡片回传交互 card.action.trigger」
  5. 创建版本并【发布】，否则配置不生效

运行：
    pip install lark-oapi
    export FEISHU_APP_ID=cli_xxx
    export FEISHU_APP_SECRET=xxx
    python3 bridge_server.py
"""

import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

import lark_oapi as lark
from lark_oapi.event.callback.model.p2_card_action_trigger import (
    P2CardActionTrigger,
    P2CardActionTriggerResponse,
)

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import session_scanner  # noqa: E402

STATE_DIR = Path(os.path.expanduser("~/.claude/feishu-bridge"))
INBOX_DIR = STATE_DIR / "inbox"
CLAUDE_P_DIR = STATE_DIR / "claude-p"
FOCUS_FILE = STATE_DIR / "focus.json"
API_BASE = "https://open.feishu.cn/open-apis"
TOKEN_CACHE = Path(os.path.expanduser("~/.cache/claude-feishu/tenant_token.json"))

# 按钮 value.action -> 注入给 Claude Code 的指令
ACTION_PROMPTS = {
    "continue": "继续执行未完成的部分，如果有 TODO 就继续做完，完成后再简要汇报。",
    "review": "对本次改动做一次代码自查，重点找 bug、边界条件、安全与性能问题，给出结论和修复建议。",
    "commit": "把本次改动整理成一条规范的 git commit 并提交（不要 push）。",
    "done": "本次任务已验收结束，输出简短总结即可。",
}

# 命令触发词
CMD_LIST = {"/list", "/ls", "/sessions", "/会话", "/会话列表", "/status", "/状态",
            "/claude", "/ps", "/help", "/帮助"}
LIST_ALIAS = {"/list", "/ls", "/sessions", "/会话", "/会话列表", "/claude", "/ps"}
STATUS_ALIAS = {"/status", "/状态"}
HELP_ALIAS = {"/help", "/帮助"}
# 中文自然语言兜底
NL_LIST = ("有哪些会话", "会话列表", "查询会话", "查看会话", "当前会话", "在跑什么",
           "有哪些任务", "跑着什么", "列出会话")

_SEEN_MSG_IDS: list[str] = []


def log(msg: str) -> None:
    line = f"[{time.strftime('%H:%M:%S')}] {msg}"
    print(line, flush=True)
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        with open(STATE_DIR / "bridge.log", "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


# --------------------------------------------------------------------------- #
# 飞书 API
# --------------------------------------------------------------------------- #
def http_post(url: str, payload: dict, headers: dict | None = None, timeout: int = 10):
    import urllib.request
    req = urllib.request.Request(
        url,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json; charset=utf-8", **(headers or {})},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def get_tenant_token() -> str:
    app_id = os.environ["FEISHU_APP_ID"]
    app_secret = os.environ["FEISHU_APP_SECRET"]
    if TOKEN_CACHE.exists():
        try:
            cache = json.loads(TOKEN_CACHE.read_text())
            if cache.get("expire_at", 0) > time.time() + 60:
                return cache["token"]
        except Exception:
            pass
    r = http_post(f"{API_BASE}/auth/v3/tenant_access_token/internal",
                  {"app_id": app_id, "app_secret": app_secret})
    token = r.get("tenant_access_token")
    if not token:
        raise RuntimeError(f"获取 token 失败: {r}")
    TOKEN_CACHE.parent.mkdir(parents=True, exist_ok=True)
    TOKEN_CACHE.write_text(json.dumps(
        {"token": token, "expire_at": time.time() + r.get("expire", 7200)}))
    return token


def reply_message(message_id: str, msg_type: str, content: str) -> None:
    """直接回复（reply）原消息，群聊里会以回复形式出现。"""
    token = get_tenant_token()
    r = http_post(
        f"{API_BASE}/im/v1/messages/{message_id}/reply",
        {"msg_type": msg_type, "content": content},
        headers={"Authorization": f"Bearer {token}"},
    )
    if r.get("code") != 0:
        raise RuntimeError(f"回复失败: {r}")


def reply_card(message_id: str, card: dict) -> None:
    reply_message(message_id, "interactive", json.dumps(card, ensure_ascii=False))


def reply_text(message_id: str, text: str) -> None:
    reply_message(message_id, "text", json.dumps({"text": text}, ensure_ascii=False))


def send_text(text: str) -> None:
    """主动发一条文本到配置的飞书会话（receive_id 来自环境变量）。"""
    id_type = os.environ.get("FEISHU_RECEIVE_ID_TYPE", "chat_id")
    receive_id = os.environ.get("FEISHU_RECEIVE_ID", "")
    if not receive_id:
        log("未配置 FEISHU_RECEIVE_ID，跳过回发")
        return
    token = get_tenant_token()
    r = http_post(
        f"{API_BASE}/im/v1/messages?receive_id_type={id_type}",
        {"receive_id": receive_id, "msg_type": "text",
         "content": json.dumps({"text": text}, ensure_ascii=False)},
        headers={"Authorization": f"Bearer {token}"},
    )
    if r.get("code") != 0:
        log(f"发送文本失败: {r}")


# --------------------------------------------------------------------------- #
# 会话选中（focus）
# --------------------------------------------------------------------------- #
def set_focus(session: dict) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    FOCUS_FILE.write_text(json.dumps({
        "session_id": session.get("session_id", ""),
        "cwd": session.get("cwd", ""),
        "project": session.get("project", ""),
        "status": session.get("status", ""),
        "set_at": time.strftime("%Y-%m-%d %H:%M:%S"),
    }, ensure_ascii=False, indent=2), encoding="utf-8")


def get_focus() -> dict | None:
    if not FOCUS_FILE.exists():
        return None
    try:
        return json.loads(FOCUS_FILE.read_text())
    except Exception:
        return None


def resolve_session(session_id: str = "", cwd: str = "") -> dict:
    """优先按 session_id / cwd 匹配，取不到就用当前 focus。"""
    result = session_scanner.scan(max_history=20)
    for s in result["sessions"]:
        if session_id and s["session_id"] == session_id:
            return s
        if cwd and s["cwd"] == cwd:
            return s
    focus = get_focus()
    if focus:
        for s in result["sessions"]:
            if focus.get("session_id") and s["session_id"] == focus["session_id"]:
                return s
            if focus.get("cwd") and s["cwd"] == focus["cwd"]:
                return s
        return focus
    return {}


# --------------------------------------------------------------------------- #
# 指令投递
# --------------------------------------------------------------------------- #
def find_tmux_pane(cwd: str | None) -> str | None:
    if not cwd:
        return None
    panes = session_scanner.scan_tmux()
    if not panes:
        return None
    for path, pane in panes.items():
        if path and (path == cwd or cwd.startswith(path.rstrip("/") + "/")):
            return pane
    return None


def deliver_to_tmux(pane: str, text: str) -> bool:
    try:
        subprocess.run(["tmux", "load-buffer", "-b", "feishu", "-"],
                       input=text, text=True, timeout=5, check=True)
        subprocess.run(["tmux", "paste-buffer", "-b", "feishu", "-t", pane],
                       timeout=5, check=True)
        subprocess.run(["tmux", "send-keys", "-t", pane, "Enter"], timeout=5, check=True)
        return True
    except Exception as e:
        log(f"tmux 注入失败: {e}")
        return False


def deliver_to_inbox(session_id: str, action: str, text: str) -> str:
    INBOX_DIR.mkdir(parents=True, exist_ok=True)
    path = INBOX_DIR / f"{int(time.time())}_{action}.json"
    path.write_text(json.dumps(
        {"session_id": session_id, "action": action, "prompt": text},
        ensure_ascii=False, indent=2), encoding="utf-8")
    return str(path)


def _claude_exe() -> str:
    """找到可在子进程里调用的 claude 可执行文件。
    Windows npm 安装的是 .cmd shim，必须让 shutil.which 按 PATHEXT 解析。"""
    for name in ("claude", "claude.exe", "claude.cmd"):
        path = shutil.which(name)
        if path:
            return path
    return ""


def deliver_to_claude_p(session_id: str, action: str, cwd: str, prompt: str) -> str:
    """无 tmux 兜底（Windows / VSCode 场景）：在目标项目目录起 `claude -p`
    无头会话执行指令，结束后把输出摘要回发到飞书。返回日志路径，失败返回空串。"""
    exe = _claude_exe()
    if not exe:
        log("找不到 claude 可执行文件，无法起无头会话")
        return ""
    CLAUDE_P_DIR.mkdir(parents=True, exist_ok=True)
    log_path = CLAUDE_P_DIR / f"{time.strftime('%Y%m%d_%H%M%S')}_{action or 'run'}.log"

    def worker() -> None:
        try:
            flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
            with open(log_path, "w", encoding="utf-8") as lf:
                lf.write(f"[prompt]\n{prompt}\n\n[output]\n")
                lf.flush()
                p = subprocess.run([exe, "-p", prompt], cwd=cwd or None,
                                   capture_output=True, text=True, timeout=1800,
                                   creationflags=flags)
                lf.write(p.stdout or "")
                if p.returncode != 0:
                    lf.write(f"\n[exit {p.returncode}]\n{p.stderr or ''}")
            out = (p.stdout or "").strip()
            if not out:
                out = (p.stderr or "").strip() or f"退出码 {p.returncode}，详见 {log_path}"
            proj = os.path.basename((cwd or "").rstrip("/\\")) or (cwd or "未知项目")
            summary = out[:3000] + ("\n…(已截断，完整输出见日志)" if len(out) > 3000 else "")
            send_text(f"🤖 claude -p「{action}」完成 · {proj}\n\n{summary}")
            log(f"claude -p [{action}] 完成，exit={p.returncode}")
        except Exception as e:
            log(f"claude -p [{action}] 异常: {e}")
            try:
                send_text(f"⚠️ claude -p「{action}」异常：{e}")
            except Exception:
                pass

    threading.Thread(target=worker, daemon=True).start()
    return str(log_path)


def deliver(action: str, session_id: str = "", cwd: str = "") -> tuple[bool, str]:
    """把指令投递到目标会话。返回 (是否成功注入, 说明)。"""
    prompt = ACTION_PROMPTS[action]
    target = resolve_session(session_id, cwd)
    t_cwd = target.get("cwd") or cwd

    pane = os.environ.get("CLAUDE_TMUX_PANE") or target.get("tmux_pane") or find_tmux_pane(t_cwd)
    if pane:
        if deliver_to_tmux(pane, prompt):
            return True, f"已注入 tmux `{pane}`"
    # 无 tmux（Windows / VSCode）：在目标目录起 claude -p 无头会话执行，结果回发飞书
    if t_cwd and os.path.isdir(t_cwd):
        log_path = deliver_to_claude_p(
            session_id or target.get("session_id", ""), action, t_cwd, prompt)
        if log_path:
            return True, f"已在 `{t_cwd}` 启动 claude -p 执行，完成后结果会发回飞书"
    path = deliver_to_inbox(session_id or target.get("session_id", ""), action, prompt)
    return False, f"未找到可注入的会话，指令已存入队列 `{path}`"


# --------------------------------------------------------------------------- #
# 卡片按钮回调
# --------------------------------------------------------------------------- #
def do_card_action_trigger(data: P2CardActionTrigger) -> P2CardActionTriggerResponse:
    try:
        value = data.event.action.value or {}
        action = value.get("action", "")
        session_id = value.get("session_id", "") or ""
        cwd = value.get("cwd", "") or ""

        if action == "list":
            # 把当前卡片原地替换成会话列表
            result = session_scanner.scan()
            log(f"卡片内查询会话列表：{result['total']} 个（执行中 {result['running']}）")
            return P2CardActionTriggerResponse({
                "card": {"type": "raw", "data": session_scanner.to_card(result)}
            })

        if action == "select":
            idx = value.get("index", "?")
            target = resolve_session(session_id, cwd)
            if not target:
                return P2CardActionTriggerResponse(
                    {"toast": {"type": "error", "content": "该会话已不存在，请重新 /list"}})
            set_focus(target)
            log(f"选中会话 #{idx} -> {target.get('project')} ({target.get('cwd')})")
            return P2CardActionTriggerResponse(
                {"toast": {"type": "success",
                           "content": f"已选中 #{idx} {target.get('project', '')}"}})

        prompt = ACTION_PROMPTS.get(action)
        if not prompt:
            log(f"未知 action: {action}")
            return P2CardActionTriggerResponse(
                {"toast": {"type": "error", "content": f"未知指令: {action}"}})

        ok, detail = deliver(action, session_id, cwd)
        log(f"action={action} -> {detail}")
        return P2CardActionTriggerResponse(
            {"toast": {"type": "success" if ok else "info",
                       "content": f"「{action}」{detail}" if ok else detail}})

    except Exception as e:
        log(f"回调处理异常: {e}")
        return P2CardActionTriggerResponse(
            {"toast": {"type": "error", "content": "处理失败，查看 bridge.log"}})


# --------------------------------------------------------------------------- #
# 命令消息
# --------------------------------------------------------------------------- #
def parse_command(text: str) -> tuple[str, str]:
    """返回 (命令, 参数)。无法识别则返回 ("", "")。"""
    raw = (text or "").strip()
    # 去掉群聊 @ 提及：@_user_1 / <at user_id="xxx">xxx</at>
    raw = re.sub(r"<at[^>]*>.*?</at>", "", raw).strip()
    raw = re.sub(r"@_\w+", "", raw).strip()
    raw = raw.replace("\u200b", "").strip()
    if not raw:
        return "", ""

    first = raw.split()[0]
    rest = raw[len(first):].strip()

    low = first.lower()
    if low in LIST_ALIAS:
        return "list", rest
    if low in STATUS_ALIAS:
        return "status", rest
    if low in HELP_ALIAS:
        return "help", rest
    if low in ("/focus", "/f", "/选中", "/切换"):
        return "focus", rest
    if low.startswith("/") and low not in CMD_LIST:
        return "unknown", first

    # 中文自然语言
    if any(k in raw for k in NL_LIST):
        return "list", ""
    if "选中" in raw and re.search(r"\d", raw):
        return "focus", re.search(r"\d+", raw).group(0)

    return "", ""


def handle_command(cmd: str, arg: str, message_id: str) -> None:
    if cmd == "list":
        result = session_scanner.scan()
        log(f"收到 /list，扫到 {result['total']} 个会话（执行中 {result['running']}）")
        reply_card(message_id, session_scanner.to_card(result))
        return

    if cmd == "status":
        focus = get_focus()
        result = session_scanner.scan()
        if not focus:
            reply_text(message_id,
                       "尚未选中会话。发送 /list 查看，再用 /focus <序号> 选中。")
            return
        cur = None
        for s in result["sessions"]:
            if s["cwd"] == focus.get("cwd") or (
                    focus.get("session_id") and s["session_id"] == focus["session_id"]):
                cur = s
                break
        if cur is None:
            reply_text(message_id,
                       f"当前选中的会话 `{focus.get('project')}` 已不在运行列表里。\n"
                       f"目录：{focus.get('cwd')}\n选中于：{focus.get('set_at')}\n\n"
                       f"发送 /list 重新选择。")
            return
        reply_text(message_id,
                   f"🎯 当前选中\n\n"
                   f"{cur['status_label']} `{cur['project']}`\n"
                   f"目录：{cur['cwd']}\n"
                   f"会话：{cur['session_id'][:8] if cur['session_id'] else '—'}\n"
                   f"更新于：{session_scanner.fmt_age(cur['age'])}\n"
                   f"tmux：{cur['tmux_pane'] or '—'}\n\n"
                   f"选中于 {focus.get('set_at')}")
        return

    if cmd == "focus":
        if not arg:
            reply_text(message_id, "用法：/focus <序号>，序号来自 /list 返回的列表。")
            return
        m = re.search(r"\d+", arg)
        if not m:
            reply_text(message_id, f"没看懂序号「{arg}」。用法：/focus 2")
            return
        idx = int(m.group(0))
        result = session_scanner.scan()
        if idx < 1 or idx > len(result["sessions"]):
            reply_text(message_id,
                       f"序号 {idx} 超出范围，当前共 {len(result['sessions'])} 个会话。"
                       f"发送 /list 查看。")
            return
        target = result["sessions"][idx - 1]
        set_focus(target)
        log(f"/focus {idx} -> {target['project']} ({target['cwd']})")
        reply_text(message_id,
                   f"🎯 已选中 #{idx}\n\n"
                   f"{target['status_label']} `{target['project']}`\n"
                   f"目录：{target['cwd']}\n"
                   f"tmux：{target['tmux_pane'] or '—'}\n\n"
                   f"之后完成卡片上的「继续/自查/提交/结束」都会作用于它。")
        return

    if cmd == "help":
        reply_text(message_id, HELP_TEXT)
        return

    if cmd == "unknown":
        reply_text(message_id, f"未知命令 {arg}。\n\n{HELP_TEXT}")
        return


HELP_TEXT = """🧭 Claude Code 飞书助手

/list （或 /ls /会话 /claude）
    列出当前所有 Claude Code 会话，含状态、目录、最近提问
    卡片上可直接点「选中 #N」

/focus <序号> （或 /f 2）
    选中某个会话，之后的按钮指令作用于它

/status （或 /状态）
    查看当前选中的是哪个会话

/help
    显示本帮助

也可以直接说：「有哪些会话」「在跑什么」

会话状态：
    🔄 执行中    transcript 60 秒内有更新
    ⏸  等待输入  进程还在但已停更
    ✅ 已结束    无进程或 transcript 超过 10 分钟未更新
"""


def do_message_receive(data) -> None:
    """处理 im.message.receive_v1。"""
    try:
        event = data.event
        msg = event.message
        msg_id = getattr(msg, "message_id", "") or ""
        chat_type = getattr(msg, "chat_type", "") or ""
        msg_type = getattr(msg, "message_type", "") or ""

        # 幂等：飞书可能重推同一条消息
        if msg_id in _SEEN_MSG_IDS:
            return
        _SEEN_MSG_IDS.append(msg_id)
        if len(_SEEN_MSG_IDS) > 200:
            del _SEEN_MSG_IDS[:-50]

        if msg_type != "text":
            return

        try:
            text = json.loads(msg.content).get("text", "")
        except Exception:
            text = getattr(msg, "content", "") or ""

        cmd, arg = parse_command(text)
        if not cmd:
            # 非命令消息：不打扰
            return

        log(f"收到命令 chat_type={chat_type} cmd={cmd} arg={arg!r}")
        handle_command(cmd, arg, msg_id)

    except Exception as e:
        log(f"消息处理异常: {e}")


# --------------------------------------------------------------------------- #
def load_env_file(path: str = "~/.claude/feishu.env") -> None:
    """启动时兜底加载 feishu.env（双击 .cmd / 计划任务启动时没有 source 环境）。
    已存在的环境变量优先，文件不覆盖。"""
    p = Path(os.path.expanduser(path))
    if not p.exists():
        return
    try:
        for ln in p.read_text(encoding="utf-8").splitlines():
            ln = ln.strip()
            if not ln or ln.startswith("#") or "=" not in ln:
                continue
            key, _, val = ln.partition("=")
            key = key.strip().replace("export ", "").strip()
            if key:
                os.environ.setdefault(key, val.strip())
    except Exception:
        pass


def main() -> int:
    # Windows 控制台默认 GBK，打印 emoji 会崩
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            try:
                stream.reconfigure(encoding="utf-8", errors="replace")
            except Exception:
                pass
    load_env_file()
    app_id = os.environ.get("FEISHU_APP_ID")
    app_secret = os.environ.get("FEISHU_APP_SECRET")
    if not app_id or not app_secret:
        print("请设置 FEISHU_APP_ID / FEISHU_APP_SECRET", file=sys.stderr)
        return 1

    STATE_DIR.mkdir(parents=True, exist_ok=True)
    INBOX_DIR.mkdir(parents=True, exist_ok=True)

    event_handler = (
        lark.EventDispatcherHandler.builder("", "")
        .register_p2_card_action_trigger(do_card_action_trigger)
        .register_p2_im_message_receive_v1(do_message_receive)
        .build()
    )

    log("启动飞书桥接：卡片回调 + 命令消息")
    log(f"Claude 目录: {session_scanner.CLAUDE_DIR}")
    cli = lark.ws.Client(app_id, app_secret,
                         event_handler=event_handler, log_level=lark.LogLevel.INFO)
    cli.start()
    return 0


if __name__ == "__main__":
    sys.exit(main())
