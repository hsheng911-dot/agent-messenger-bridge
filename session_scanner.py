#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
扫描当前机器上「正在执行 / 挂起」的 Claude Code 会话。

三个信息源交叉验证：
  1. 进程表  —— ps 找出 claude 相关进程，拿 pid / cpu / 运行时长 / cwd
  2. tmux    —— 找出跑着 claude 的 pane，方便后续注入指令
  3. transcript —— ~/.claude/projects/**/*.jsonl 的 mtime，判断活跃度与最近提问

会话状态判定：
  🔄 执行中    transcript 在 ACTIVE_SEC 内有写入，或进程 CPU 明显占用
  ⏸  等待输入  进程还在，但 transcript 已有一段时间没更新
  💤 已结束    进程已退出，仅剩 transcript

单独调试：
    python3 session_scanner.py            # 打印表格
    python3 session_scanner.py --json     # 输出 JSON
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

# transcript 多久内有写入算「执行中」
ACTIVE_SEC = 60
# 进程还在但 transcript 多久没更新算「等待输入」（超过则视为已结束）
IDLE_SEC = 600
# 列出最近多少个历史会话
MAX_HISTORY = 8

CLAUDE_DIR = Path(os.path.expanduser(os.environ.get("CLAUDE_CONFIG_DIR", "~/.claude")))
PROJECTS_DIR = CLAUDE_DIR / "projects"

# 自身脚本相关，扫描时要排除
SELF_MARKERS = (
    "session_scanner",
    "notify_card.py",
    "bridge_server.py",
    "feishu",
)


# --------------------------------------------------------------------------- #
# 进程扫描
# --------------------------------------------------------------------------- #
def _run(cmd: list[str], timeout: int = 5) -> str:
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return out.stdout if out.returncode == 0 else ""
    except Exception:
        return ""


def proc_cwd(pid: int) -> str:
    """拿进程工作目录：Linux 读 /proc，macOS 用 lsof。"""
    link = Path(f"/proc/{pid}/cwd")
    try:
        return os.readlink(link)
    except Exception:
        pass
    if sys.platform == "darwin":
        out = _run(["lsof", "-a", "-d", "cwd", "-p", str(pid), "-Fn"])
        for line in out.splitlines():
            if line.startswith("n/"):
                return line[1:]
    return ""


def is_claude_cmd(cmd: str) -> bool:
    low = cmd.lower()
    if "claude" not in low:
        return False
    # 排除 grep / 本工具链自身
    if any(m in low for m in SELF_MARKERS):
        return False
    if low.lstrip().startswith("grep"):
        return False
    return True


def scan_processes() -> list[dict]:
    """返回正在跑的 claude 进程列表。"""
    out = _run(["ps", "-eo", "pid=,ppid=,pcpu=,etime=,command="])
    procs = []
    for line in out.splitlines():
        line = line.strip()
        if not line:
            continue
        parts = line.split(None, 4)
        if len(parts) < 5:
            continue
        pid_s, ppid_s, cpu_s, etime, cmd = parts
        if not is_claude_cmd(cmd):
            continue
        try:
            pid = int(pid_s)
        except ValueError:
            continue
        try:
            cpu = float(cpu_s)
        except ValueError:
            cpu = 0.0
        procs.append({
            "pid": pid,
            "ppid": int(ppid_s) if ppid_s.isdigit() else 0,
            "cpu": cpu,
            "etime": etime,
            "cmd": cmd[:120],
            "cwd": proc_cwd(pid),
        })
    return procs


# --------------------------------------------------------------------------- #
# tmux 扫描
# --------------------------------------------------------------------------- #
def scan_tmux() -> dict[str, str]:
    """返回 {cwd: pane_id}，只收跑着 claude 的 pane。"""
    out = _run(["tmux", "list-panes", "-a", "-F",
                "#{pane_id}\t#{pane_current_path}\t#{pane_current_command}"])
    if not out:
        return {}
    result: dict[str, str] = {}
    for line in out.splitlines():
        parts = line.split("\t")
        if len(parts) != 3:
            continue
        pane_id, path, cmd = parts
        if "claude" in cmd.lower() or "node" in cmd.lower():
            result[path] = pane_id
    return result


# --------------------------------------------------------------------------- #
# transcript 扫描
# --------------------------------------------------------------------------- #
def _first_user_line(path: Path, limit_bytes: int = 200_000) -> str:
    """从 transcript 里取第一条真正的用户提问（跳过工具结果）。"""
    try:
        with open(path, "r", encoding="utf-8", errors="ignore") as f:
            for _ in range(30):
                ln = f.readline()
                if not ln:
                    break
                if len(ln.encode()) > limit_bytes:
                    break
                try:
                    obj = json.loads(ln)
                except Exception:
                    continue
                if obj.get("type") != "user":
                    continue
                content = obj.get("message", {}).get("content")
                text = ""
                if isinstance(content, str):
                    text = content
                elif isinstance(content, list):
                    for b in content:
                        if isinstance(b, dict) and b.get("type") == "text":
                            text = b.get("text", "")
                            break
                        if isinstance(b, dict) and b.get("type") == "tool_result":
                            text = ""
                            break
                text = re.sub(r"<system-reminder>.*?</system-reminder>", "", text, flags=re.S)
                text = text.strip()
                if text:
                    return text
    except Exception:
        pass
    return ""


def _transcript_cwd(path: Path) -> str:
    """尽力从 transcript 首条记录里还原项目目录。"""
    try:
        with open(path, "r", encoding="utf-8", errors="ignore") as f:
            ln = f.readline()
        obj = json.loads(ln)
        if isinstance(obj, dict) and obj.get("cwd"):
            return obj["cwd"]
    except Exception:
        pass
    return ""


def scan_transcripts(max_history: int = MAX_HISTORY) -> list[dict]:
    """扫描 ~/.claude/projects/**/*.jsonl，按最近修改时间排序。"""
    if not PROJECTS_DIR.exists():
        return []
    items = []
    now = time.time()
    for p in PROJECTS_DIR.rglob("*.jsonl"):
        try:
            st = p.stat()
        except Exception:
            continue
        items.append({
            "session_id": p.stem,
            "transcript": str(p),
            "mtime": st.st_mtime,
            "age": now - st.st_mtime,
        })
    items.sort(key=lambda x: x["mtime"], reverse=True)
    return items[:max_history]


# --------------------------------------------------------------------------- #
# 汇总
# --------------------------------------------------------------------------- #
def _status_of(age: float, alive: bool, cpu: float) -> tuple[str, str]:
    # transcript 太久没动 —— 无论有没有进程，都视为已结束
    if age > IDLE_SEC:
        return "dead", "✅ 已结束"
    if alive and (age <= ACTIVE_SEC or cpu >= 5.0):
        return "running", "🔄 执行中"
    if alive:
        return "idle", "⏸ 等待输入"
    # 没匹配到进程，但 transcript 刚写入过（可能是 ps 看不到子进程）
    if age <= ACTIVE_SEC:
        return "running", "🔄 执行中"
    return "dead", "✅ 已结束"


def scan(max_history: int = MAX_HISTORY) -> dict:
    procs = scan_processes()
    panes = scan_tmux()
    transcripts = scan_transcripts(max_history * 2)

    alive_cwds = {p["cwd"] for p in procs if p["cwd"]}
    alive_cpu = {p["cwd"]: p["cpu"] for p in procs if p["cwd"]}
    pids = {p["cwd"]: p["pid"] for p in procs if p["cwd"]}
    etimes = {p["cwd"]: p["etime"] for p in procs if p["cwd"]}

    sessions: list[dict] = []

    # 1) 有 transcript 的会话：能拿到最近提问，信息最全
    matched_cwds: set[str] = set()
    for t in transcripts:
        cwd = _transcript_cwd(Path(t["transcript"]))
        # 用 cwd 匹配活进程；匹配不上就靠 transcript 新鲜度判断
        alive = False
        cpu = 0.0
        pid = None
        etime = ""
        for pc in alive_cwds:
            if cwd and (pc == cwd or cwd.startswith(pc.rstrip("/") + "/")):
                alive, cpu, pid, etime = True, alive_cpu[pc], pids[pc], etimes[pc]
                matched_cwds.add(pc)
                break
        if not alive:
            # 进程没匹配上，但 transcript 刚更新过，仍算活跃
            alive = t["age"] <= ACTIVE_SEC

        code, label = _status_of(t["age"], alive, cpu)
        sessions.append({
            "session_id": t["session_id"],
            "cwd": cwd or "（未知目录）",
            "project": os.path.basename(cwd.rstrip("/")) if cwd else "（未知）",
            "status": code,
            "status_label": label,
            "age": t["age"],
            "alive": alive,
            "pid": pid,
            "cpu": cpu,
            "etime": etime,
            "tmux_pane": panes.get(cwd, ""),
            "last_question": _first_user_line(Path(t["transcript"])),
        })

    # 2) 有进程但没匹配到 transcript 的（比如刚启动还没落盘）
    for pc in alive_cwds - matched_cwds:
        sessions.append({
            "session_id": "",
            "cwd": pc,
            "project": os.path.basename(pc.rstrip("/")) or pc,
            "status": "running",
            "status_label": "🔄 执行中",
            "age": 0,
            "alive": True,
            "pid": pids.get(pc),
            "cpu": alive_cpu.get(pc, 0.0),
            "etime": etimes.get(pc, ""),
            "tmux_pane": panes.get(pc, ""),
            "last_question": "",
        })

    running = [s for s in sessions if s["status"] == "running"]
    others = [s for s in sessions if s["status"] != "running"]
    sessions = running + others

    return {
        "total": len(sessions),
        "running": len(running),
        "idle": len([s for s in sessions if s["status"] == "idle"]),
        "has_tmux": bool(panes),
        "sessions": sessions[: max(max_history, len(running))],
        "scanned_at": time.strftime("%Y-%m-%d %H:%M:%S"),
    }


# --------------------------------------------------------------------------- #
def fmt_age(sec: float) -> str:
    sec = int(sec)
    if sec < 60:
        return f"{sec} 秒前"
    if sec < 3600:
        return f"{sec // 60} 分钟前"
    if sec < 86400:
        return f"{sec // 3600} 小时前"
    return f"{sec // 86400} 天前"


def to_text(result: dict) -> str:
    """纯文本版，用于快速查看 / 不支持卡片时兜底。"""
    if not result["sessions"]:
        return "当前没有检测到 Claude Code 会话。\n（确认 claude 正在运行，或检查 ~/.claude/projects 是否存在）"

    lines = [f"🧭 Claude Code 会话（执行中 {result['running']} · 共 {result['total']}）",
             f"扫描于 {result['scanned_at']}", ""]
    for i, s in enumerate(result["sessions"], 1):
        lines.append(f"{i}. {s['status_label']}  {s['project']}")
        lines.append(f"   目录 {s['cwd']}")
        if s["status"] in ("running", "idle") and s["pid"]:
            lines.append(f"   pid {s['pid']} · cpu {s['cpu']}% · 已运行 {s['etime']}")
        if s["tmux_pane"]:
            lines.append(f"   tmux {s['tmux_pane']}")
        if s["session_id"]:
            lines.append(f"   会话 {s['session_id'][:8]} · 更新于 {fmt_age(s['age'])}")
        if s["last_question"]:
            q = s["last_question"].replace("\n", " ")[:80]
            lines.append(f"   💬 {q}")
        lines.append("")
    lines.append("用 /focus <序号> 选中会话，之后的指令会作用于它。")
    return "\n".join(lines)


# --------------------------------------------------------------------------- #
def to_card(result: dict) -> dict:
    """卡片版（飞书卡片 JSON 2.0，客户端 7.20+）。"""
    elements: list[dict] = []

    if not result["sessions"]:
        return {
            "schema": "2.0",
            "config": {"update_multi": True, "width_mode": "fill"},
            "header": {
                "template": "grey",
                "title": {"tag": "plain_text", "content": "🧭 没有运行中的会话"},
            },
            "body": {
                "direction": "vertical",
                "padding": "12px",
                "elements": [
                    {"tag": "markdown",
                     "content": "当前没有检测到 Claude Code 会话。\n\n"
                                "确认 `claude` 正在运行，或检查 `~/.claude/projects` 是否存在。"},
                ],
            },
        }

    elements.append({
        "tag": "markdown",
        "content": (
            f"**执行中 {result['running']}** · 等待输入 {result['idle']} · 共 {result['total']}\n\n"
            f"<font color='grey'>扫描于 {result['scanned_at']}</font>"
        ),
    })
    elements.append({"tag": "hr"})

    for i, s in enumerate(result["sessions"], 1):
        q = s["last_question"].replace("\n", " ").replace("```", "'''")
        q = q[:70] + ("…" if len(q) > 70 else "")
        meta = []
        if s["status"] in ("running", "idle") and s["pid"]:
            meta.append(f"pid `{s['pid']}` · cpu {s['cpu']}%")
        if s["tmux_pane"]:
            meta.append(f"tmux `{s['tmux_pane']}`")
        meta.append(f"更新于 {fmt_age(s['age'])}")

        block = (
            f"**{i}. {s['status_label']} `{s['project']}`**\n\n"
            f"`{s['cwd']}`\n\n"
            + " · ".join(meta)
        )
        if s["session_id"]:
            block += f" · 会话 `{s['session_id'][:8]}`"
        if q:
            block += f"\n\n💬 {q}"

        elements.append({"tag": "markdown", "content": block})
        elements.append({"tag": "hr"})

    # 选中按钮：最多 5 个会话，两列排布
    selectable = result["sessions"][:5]

    def sel_btn(i: int, sid: str, cwd: str):
        return {
            "tag": "button",
            "text": {"tag": "plain_text", "content": f"选中 #{i}"},
            "type": "default",
            "size": "small",
            "width": "fill",
            "behaviors": [{
                "type": "callback",
                "value": {"action": "select", "index": i, "session_id": sid, "cwd": cwd},
            }],
        }

    for i in range(0, len(selectable), 2):
        chunk = selectable[i:i + 2]
        columns = []
        for j, s in enumerate(chunk):
            idx = i + j + 1
            columns.append({
                "tag": "column",
                "width": "weighted",
                "weight": 1,
                "elements": [sel_btn(idx, s["session_id"], s["cwd"])],
            })
        if len(columns) == 1:
            columns.append({"tag": "column", "width": "weighted", "weight": 1, "elements": []})
        elements.append({
            "tag": "column_set",
            "flex_mode": "bisect",
            "horizontal_spacing": "8px",
            "columns": columns,
        })

    elements.append({
        "tag": "markdown",
        "content": "<font color='grey'>选中后，完成卡片上的「继续/自查/提交/结束」会作用于该会话；"
                   "也可直接发送 <font color='blue'>/focus 2</font></font>",
    })

    return {
        "schema": "2.0",
        "config": {"update_multi": True, "width_mode": "fill"},
        "header": {
            "template": "blue",
            "title": {"tag": "plain_text", "content": "🧭 Claude Code 会话列表"},
            "subtitle": {"tag": "plain_text",
                         "content": f"执行中 {result['running']} · 共 {result['total']}"},
        },
        "body": {"direction": "vertical", "padding": "12px", "elements": elements},
    }


# --------------------------------------------------------------------------- #
if __name__ == "__main__":
    # Windows 控制台默认 GBK，打印 emoji 会崩
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            try:
                stream.reconfigure(encoding="utf-8", errors="replace")
            except Exception:
                pass
    res = scan()
    if "--json" in sys.argv:
        print(json.dumps(res, ensure_ascii=False, indent=2))
    else:
        print(to_text(res))
        print("\n--- 卡片元素数 ---", len(to_card(res)["body"]["elements"]))
