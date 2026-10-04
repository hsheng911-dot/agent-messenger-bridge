#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Claude Code  ->  飞书交互卡片

用法（作为 Claude Code 的 Stop hook 被调用，stdin 接收 Claude 传来的 JSON）：

    python3 ~/.claude/notify_card.py

两种发送模式（由环境变量 FEISHU_MODE 决定）：
  webhook : 群「自定义机器人」Webhook。能发卡片，但【按钮点击不会有回调】，
            按钮会自动降级为 open_url 或省略。
  app     : 企业自建应用机器人。支持真正的按钮回调（card.action.trigger），
            需要配合 bridge_server.py 使用。

必需环境变量：
  FEISHU_MODE              webhook | app
  # --- webhook 模式 ---
  FEISHU_WEBHOOK           https://open.feishu.cn/open-apis/bot/v2/hook/xxxx
  # --- app 模式 ---
  FEISHU_APP_ID            cli_xxxx
  FEISHU_APP_SECRET        xxxxx
  FEISHU_RECEIVE_ID_TYPE   chat_id | open_id | user_id | email
  FEISHU_RECEIVE_ID        oc_xxxx / ou_xxxx

可选环境变量：
  FEISHU_DEBOUNCE_SEC      同一会话多少秒内只发一次，默认 45（0 = 每轮都发）
  FEISHU_TURNS             卡片里展示最近几轮「用户提问 + AI 输出」，默认 1；
                           设为 0 表示输出整个会话的全部轮次
  FEISHU_MAX_CHARS         AI 输出最大字符数，默认 1200（超出截断）
  FEISHU_BTN_LINK          webhook 模式下按钮跳转的链接（如 commit 页面）
  CLAUDE_PROJECT_DIR       由 Claude Code 自动注入

问答来源：优先读 Claude Code 的 transcript（transcript_path），
从中回溯出每一轮的用户原始提问与 AI 输出；
若官方字段 last_assistant_message 存在，则摘要用它兜底。
"""

import hashlib
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

STATE_DIR = Path(os.path.expanduser("~/.claude/feishu-bridge"))
TOKEN_CACHE = Path(os.path.expanduser("~/.cache/claude-feishu/tenant_token.json"))
API_BASE = "https://open.feishu.cn/open-apis"


# --------------------------------------------------------------------------- #
# 基础工具
# --------------------------------------------------------------------------- #
def log(msg: str) -> None:
    print(f"[feishu-card] {msg}", file=sys.stderr)


def http_post(url: str, payload: dict, headers: dict | None = None, timeout: int = 10):
    req = urllib.request.Request(
        url,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json; charset=utf-8", **(headers or {})},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def http_get(url: str, headers: dict | None = None, timeout: int = 10):
    req = urllib.request.Request(url, headers=headers or {}, method="GET")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def read_hook_input() -> dict:
    """读取 Claude Code 通过 stdin 传入的 JSON，失败则返回空字典。"""
    try:
        raw = sys.stdin.read()
        return json.loads(raw) if raw.strip() else {}
    except Exception:
        return {}


def truncate(text: str, limit: int = 900) -> str:
    text = (text or "").strip()
    return text if len(text) <= limit else text[:limit] + "\n…(已截断)"


def fmt_tokens(n: int) -> str:
    """token 数转易读格式：1234567 -> 1.2M，12345 -> 12.3k。"""
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M"
    if n >= 1_000:
        return f"{n / 1_000:.1f}k"
    return str(n)


def fmt_duration(sec: float) -> str:
    """秒数转易读时长：452 -> 7分32秒，4500 -> 1小时15分。"""
    sec = int(sec)
    if sec < 60:
        return f"{sec}秒"
    if sec < 3600:
        return f"{sec // 60}分{sec % 60}秒"
    return f"{sec // 3600}小时{sec % 3600 // 60}分"


def _load_transcript(path: str | None) -> list[dict]:
    """读取 Claude Code 的 transcript JSONL，返回解析成功的记录列表。"""
    if not path or not os.path.exists(path):
        return []
    objs = []
    try:
        with open(path, "r", encoding="utf-8", errors="ignore") as f:
            for ln in f:
                ln = ln.strip()
                if not ln:
                    continue
                try:
                    objs.append(json.loads(ln))
                except Exception:
                    continue
    except Exception:
        return []
    return objs


def _extract_text(message: dict, role: str) -> str:
    """从一条 message 里抽出人类可读的文本，跳过工具调用/结果/思考块。"""
    if not isinstance(message, dict):
        return ""
    content = message.get("content")

    if isinstance(content, str):
        return content

    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if not isinstance(block, dict):
                continue
            btype = block.get("type")
            if btype == "text":
                parts.append(block.get("text", ""))
            elif btype == "tool_use" and role == "assistant":
                # 工具调用也记一笔，否则「AI 输出」会缺上下文
                name = block.get("name", "tool")
                target = ""
                inp = block.get("input") or {}
                if isinstance(inp, dict):
                    target = inp.get("file_path") or inp.get("command") or inp.get("pattern") or ""
                parts.append(f"🔧 调用 `{name}` {target}".rstrip())
            # tool_result / thinking / redacted_thinking 一律忽略
        return "\n".join(p for p in parts if p.strip())

    return ""


def _clean_user_text(text: str) -> str:
    """去掉 Claude Code 注入的 system-reminder、以及斜杠命令标记。"""
    text = re.sub(r"<system-reminder>.*?</system-reminder>", "", text, flags=re.S)
    text = re.sub(r"<command-name>.*?</command-name>", "", text, flags=re.S)
    return text.strip()


def parse_turns(path: str | None) -> list[dict]:
    """
    把 transcript 按原始顺序切成「轮次」。

    一轮 = 一条 user 消息 + 紧随其后（直到下一条 user 之前）的 assistant 输出。
    每轮附带起止时间与 token 消耗（assistant 消息按 message.id 去重后累加 usage），
    这样耗时/Token 就能对应到卡片实际展示的那几轮提问。
    """
    objs = _load_transcript(path)
    if not objs:
        return []

    def _ts(obj: dict):
        ts = obj.get("timestamp")
        if isinstance(ts, str) and ts:
            try:
                return datetime.fromisoformat(ts.replace("Z", "+00:00"))
            except Exception:
                pass
        return None

    turns: list[dict] = []
    seen_ids: set[str] = set()
    for obj in objs:
        role = obj.get("type")
        if role not in ("user", "assistant"):
            continue
        msg = obj.get("message", {}) if isinstance(obj.get("message"), dict) else {}
        ts = _ts(obj)

        if role == "user":
            text = _clean_user_text(_extract_text(msg, role))
            if not text:
                continue  # 纯工具结果，不是真正的提问
            turns.append({"question": text, "answer": "", "start": ts, "end": ts,
                          "input": 0, "output": 0, "cache_creation": 0, "cache_read": 0})
            continue

        # assistant：先按 message.id 去重累加 token，再拼接文本
        mid = msg.get("id")
        if mid:
            if mid in seen_ids:
                continue
            seen_ids.add(mid)
        usage = msg.get("usage") or {}
        if not turns:
            # 会话开头没有提问，先有输出
            turns.append({"question": "（会话开头的输出）", "answer": "", "start": ts, "end": ts,
                          "input": 0, "output": 0, "cache_creation": 0, "cache_read": 0})
        cur = turns[-1]
        cur["input"] += usage.get("input_tokens") or 0
        cur["output"] += usage.get("output_tokens") or 0
        cur["cache_creation"] += usage.get("cache_creation_input_tokens") or 0
        cur["cache_read"] += usage.get("cache_read_input_tokens") or 0

        text = _extract_text(msg, role)
        if text:
            # 同一轮内多段 assistant 输出拼接（中间可能夹了工具调用）
            cur["answer"] = (cur["answer"] + "\n" + text).strip() if cur["answer"] else text
        if ts:
            cur["end"] = ts

    # 丢掉最后没有 AI 输出的半轮（用户刚提问还没回答就被打断的情况）
    if turns and not turns[-1]["answer"]:
        turns.pop()

    return turns


def recent_turns(path: str | None, max_turns: int = 1):
    """从 transcript 末尾取最近 N 轮，返回 [(用户提问, AI输出), ...]（由旧到新）。"""
    pairs = [(t["question"], t["answer"]) for t in parse_turns(path)]
    return pairs[-max_turns:] if max_turns > 0 else pairs


def turns_stats(turns: list[dict], whole_session: bool = False) -> dict:
    """统计展示轮次的耗时与 token 消耗。

    耗时 = 各轮处理时间之和（提问到该轮最后一条输出，不含轮与轮之间的空闲）。
    输入含缓存写入/读取（缓存读取占大头，是正常现象）。
    """
    st = {"duration_sec": 0, "input": 0, "output": 0,
          "cache_creation": 0, "cache_read": 0, "label": ""}
    for t in turns:
        if t.get("start") and t.get("end"):
            st["duration_sec"] += max(0, int((t["end"] - t["start"]).total_seconds()))
        st["input"] += t.get("input", 0)
        st["output"] += t.get("output", 0)
        st["cache_creation"] += t.get("cache_creation", 0)
        st["cache_read"] += t.get("cache_read", 0)
    if whole_session:
        st["label"] = "整个会话"
    else:
        st["label"] = "本轮" if len(turns) <= 1 else f"最近{len(turns)}轮合计"
    return st


def last_assistant_message(hook: dict) -> str:
    """优先用官方字段，取不到就从 transcript 里回溯最后一条 assistant 消息。"""
    msg = hook.get("last_assistant_message")
    if msg:
        return msg
    turns = recent_turns(hook.get("transcript_path"), max_turns=1)
    return turns[-1][1] if turns else "（无摘要）"


def git_info(cwd: str) -> tuple[str, str]:
    def run(args):
        try:
            out = subprocess.run(
                args, cwd=cwd or ".", capture_output=True, text=True, timeout=5
            )
            return out.stdout.strip()
        except Exception:
            return ""

    branch = run(["git", "rev-parse", "--abbrev-ref", "HEAD"]) or "-"
    dirty = run(["git", "status", "--porcelain"])
    return branch, ("有未提交改动" if dirty else "工作区干净")


# --------------------------------------------------------------------------- #
# 卡片构造
# --------------------------------------------------------------------------- #
def build_card(ctx: dict, mode: str) -> dict:
    """构造飞书卡片 JSON 2.0（需飞书客户端 7.20+）。"""
    sid = ctx["session_id"]

    def btn(text: str, action: str, style: str = "default"):
        b = {
            "tag": "button",
            "text": {"tag": "plain_text", "content": text},
            "type": style,
            "size": "medium",
            "width": "fill",
        }
        if mode == "app":
            # 真正的回传按钮：bridge_server.py 会收到 value
            b["behaviors"] = [
                {"type": "callback", "value": {"action": action, "session_id": sid}}
            ]
        else:
            # 自定义机器人不支持回调，降级为跳转；没配链接就不加 behaviors
            link = os.environ.get("FEISHU_BTN_LINK", "").strip()
            if link:
                b["behaviors"] = [{"type": "open_url", "default_url": link}]
        return b

    def code_block(text: str, limit: int) -> str:
        """放进 ``` 代码块，防止用户内容里的 markdown 破坏卡片结构。"""
        body = truncate(text, limit).replace("```", "'''")
        return f"```\n{body}\n```" if body else "```\n（空）\n```"

    max_chars = int(os.environ.get("FEISHU_MAX_CHARS", "1200"))
    turns = ctx.get("turns") or []

    elements = [
        {
            "tag": "markdown",
            "content": (
                f"**项目** `{ctx['project']}`\n\n"
                f"**分支** `{ctx['branch']}` · {ctx['git_status']}\n\n"
                f"**时间** {ctx['time']} · **会话** `{sid[:8]}`"
            ),
        },
        {"tag": "hr"},
    ]

    # 耗时 + token 消耗（对应卡片展示的轮次，默认最近 1 轮）
    st = ctx.get("stats") or {}
    if st.get("output") or st.get("input"):
        total_in = st.get("input", 0) + st.get("cache_creation", 0) + st.get("cache_read", 0)
        label = st.get("label") or "本轮"
        elements.insert(1, {
            "tag": "markdown",
            "content": (
                f"**⏱ {label}耗时** {fmt_duration(st.get('duration_sec', 0))} · "
                f"**🔢 Token** 输入(含缓存) {fmt_tokens(total_in)} · "
                f"输出 {fmt_tokens(st.get('output', 0))}"
            ),
        })

    if turns:
        n = len(turns)
        for i, (question, answer) in enumerate(turns, 1):
            label = f"第 {i}/{n} 轮" if n > 1 else "本轮对话"
            elements += [
                {"tag": "markdown", "content": f"**🙋 用户提问**（{label}）"},
                {"tag": "markdown", "content": code_block(question, 600)},
                {"tag": "markdown", "content": "**🤖 AI 输出**"},
                {"tag": "markdown", "content": code_block(answer, max_chars)},
            ]
            if i < n:
                elements.append({"tag": "hr"})
    else:
        elements.append(
            {"tag": "markdown",
             "content": "**🤖 AI 输出**\n" + code_block(ctx["summary"], max_chars)}
        )

    if mode == "app":
        elements += [
            {"tag": "hr"},
            {
                "tag": "column_set",
                "flex_mode": "bisect",
                "horizontal_spacing": "8px",
                "columns": [
                    {"tag": "column", "width": "weighted", "weight": 1,
                     "elements": [btn("▶ 继续", "continue", "primary_filled")]},
                    {"tag": "column", "width": "weighted", "weight": 1,
                     "elements": [btn("🔍 自查", "review", "default")]},
                ],
            },
            {
                "tag": "column_set",
                "flex_mode": "bisect",
                "horizontal_spacing": "8px",
                "columns": [
                    {"tag": "column", "width": "weighted", "weight": 1,
                     "elements": [btn("📦 提交", "commit", "default")]},
                    {"tag": "column", "width": "weighted", "weight": 1,
                     "elements": [btn("✅ 结束", "done", "danger")]},
                ],
            },
            {
                "tag": "column_set",
                "flex_mode": "bisect",
                "horizontal_spacing": "8px",
                "columns": [
                    {"tag": "column", "width": "weighted", "weight": 1,
                     "elements": [btn("🧭 全部会话", "list", "text")]},
                    {"tag": "column", "width": "weighted", "weight": 1, "elements": []},
                ],
            },
            {
                "tag": "markdown",
                "content": "<font color='grey'>点击后指令会注入到运行中的 Claude Code 会话</font>",
            },
        ]
    else:
        elements += [
            {"tag": "hr"},
            {
                "tag": "markdown",
                "content": (
                    "<font color='orange'>当前为「自定义机器人」模式，按钮点击**不会产生回调**。"
                    "改用企业自建应用即可启用交互按钮。</font>"
                ),
            },
        ]

    return {
        "schema": "2.0",
        "config": {"update_multi": True, "width_mode": "fill"},
        "header": {
            "template": "turquoise",
            "title": {"tag": "plain_text", "content": "✅ Claude Code 任务完成"},
            "subtitle": {"tag": "plain_text", "content": ctx["project"]},
        },
        "body": {"direction": "vertical", "padding": "12px", "elements": elements},
    }


# --------------------------------------------------------------------------- #
# 发送
# --------------------------------------------------------------------------- #
def send_webhook(webhook: str, card: dict) -> None:
    r = http_post(webhook, {"msg_type": "interactive", "card": card})
    if r.get("code") != 0 and r.get("StatusCode") != 0:
        log(f"webhook 返回异常: {r}")
    else:
        log("卡片已发送 (webhook)")


def get_tenant_token(app_id: str, app_secret: str) -> str:
    if TOKEN_CACHE.exists():
        try:
            cache = json.loads(TOKEN_CACHE.read_text())
            if cache.get("expire_at", 0) > time.time() + 60:
                return cache["token"]
        except Exception:
            pass

    r = http_post(
        f"{API_BASE}/auth/v3/tenant_access_token/internal",
        {"app_id": app_id, "app_secret": app_secret},
    )
    token = r.get("tenant_access_token")
    if not token:
        raise RuntimeError(f"获取 tenant_access_token 失败: {r}")
    TOKEN_CACHE.parent.mkdir(parents=True, exist_ok=True)
    TOKEN_CACHE.write_text(
        json.dumps({"token": token, "expire_at": time.time() + r.get("expire", 7200)})
    )
    return token


def send_app(card: dict) -> None:
    app_id = os.environ["FEISHU_APP_ID"]
    app_secret = os.environ["FEISHU_APP_SECRET"]
    id_type = os.environ.get("FEISHU_RECEIVE_ID_TYPE", "chat_id")
    receive_id = os.environ["FEISHU_RECEIVE_ID"]

    token = get_tenant_token(app_id, app_secret)
    r = http_post(
        f"{API_BASE}/im/v1/messages?receive_id_type={id_type}",
        {
            "receive_id": receive_id,
            "msg_type": "interactive",
            "content": json.dumps(card, ensure_ascii=False),
        },
        headers={"Authorization": f"Bearer {token}"},
    )
    if r.get("code") != 0:
        raise RuntimeError(f"发送卡片失败: {r}")
    log(f"卡片已发送 (app), message_id={r.get('data', {}).get('message_id')}")


# --------------------------------------------------------------------------- #
# 去抖
# --------------------------------------------------------------------------- #
def debounced(session_id: str, sec: int) -> bool:
    """返回 True 表示本次应跳过发送。"""
    if sec <= 0:
        return False
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    stamp = STATE_DIR / f".last_{session_id[:8]}"
    now = time.time()
    if stamp.exists():
        try:
            if now - float(stamp.read_text()) < sec:
                return True
        except Exception:
            pass
    stamp.write_text(str(now))
    return False


# --------------------------------------------------------------------------- #
def load_env_file(path: str = "~/.claude/feishu.env") -> None:
    """启动时兜底加载 feishu.env（Windows 下 hook 不一定带着 source 过的环境）。
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
    mode = os.environ.get("FEISHU_MODE", "webhook").strip().lower()
    hook = read_hook_input()

    session_id = hook.get("session_id") or os.environ.get("CLAUDE_SESSION_ID") or "unknown"
    if session_id == "unknown" and hook.get("transcript_path"):
        session_id = hashlib.md5(hook["transcript_path"].encode()).hexdigest()

    try:
        sec = int(os.environ.get("FEISHU_DEBOUNCE_SEC", "45"))
    except ValueError:
        sec = 45
    if debounced(session_id, sec):
        log("命中去抖窗口，跳过本次通知")
        return 0

    cwd = os.environ.get("CLAUDE_PROJECT_DIR") or hook.get("cwd") or os.getcwd()
    branch, git_status = git_info(cwd)

    # 提取最近 N 轮完整问答（0 = 整个会话全部轮次）；耗时/Token 统计对应展示的轮次
    try:
        max_turns = int(os.environ.get("FEISHU_TURNS", "1"))
    except ValueError:
        max_turns = 1
    shown = parse_turns(hook.get("transcript_path"))
    shown = shown[-max_turns:] if max_turns > 0 else shown
    turns = [(t["question"], t["answer"]) for t in shown]

    ctx = {
        "session_id": session_id,
        "project": os.path.basename(cwd.rstrip("/")) or cwd,
        "branch": branch,
        "git_status": git_status,
        "time": time.strftime("%Y-%m-%d %H:%M:%S"),
        "summary": last_assistant_message(hook),
        "turns": turns,
        "stats": turns_stats(shown, whole_session=(max_turns == 0)),
    }
    log(f"解析到 {len(turns)} 轮对话 (FEISHU_TURNS={max_turns})")

    card = build_card(ctx, mode)

    try:
        if mode == "app":
            send_app(card)
        else:
            send_webhook(os.environ["FEISHU_WEBHOOK"], card)
    except urllib.error.URLError as e:
        log(f"网络错误: {e}")
    except KeyError as e:
        log(f"缺少环境变量: {e}")
    except Exception as e:  # hook 绝不能因通知失败而中断 Claude
        log(f"发送失败: {e}")

    # 会话上下文落盘，供回调服务定位 tmux pane
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    (STATE_DIR / f"session_{session_id[:8]}.json").write_text(
        json.dumps({"session_id": session_id, "cwd": cwd, "time": ctx["time"]},
                   ensure_ascii=False, indent=2)
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
