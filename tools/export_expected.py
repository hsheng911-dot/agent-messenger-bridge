#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
用 Python 版 notify_card.parse_turns 对每个 fixture 生成期望输出,
存成 test/expected/python-parse.json,供 Node 侧对照测试(test/transcript.test.js)。

运行(在项目根目录):
    py -3 tools/export_expected.py      # Windows
    python3 tools/export_expected.py    # macOS / Linux
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from notify_card import parse_turns, turns_stats  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "test" / "fixtures"
OUT = ROOT / "test" / "expected" / "python-parse.json"


def iso(ts):
    return ts.isoformat() if ts else None


def main():
    out = {}
    for f in sorted(FIXTURES.glob("*.jsonl")):
        turns = parse_turns(str(f))
        out[f.name] = {
            "turns": [
                {
                    "question": t["question"],
                    "answer": t["answer"],
                    "start": iso(t["start"]),
                    "end": iso(t["end"]),
                    "input": t["input"],
                    "output": t["output"],
                    "cache_creation": t["cache_creation"],
                    "cache_read": t["cache_read"],
                }
                for t in turns
            ],
            "stats_turn1": turns_stats(turns[-1:]),
            "stats_whole": turns_stats(turns, whole_session=True),
        }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"written: {OUT.relative_to(ROOT)} ({len(out)} fixtures)")


if __name__ == "__main__":
    main()
