"""Model input text, exactly as the daemon renders it (brain/CONTRACT.md, `brain/src/agento_brain/textin.py`).

Training and serving must produce the same string for the same task, so this module is a port of the daemon's rendering
(`render`, `header_fields`, `compact_number`, `head_tail`) and of the two prompt features the daemon derives itself when the
request context does not carry them (`lang`, `mentions`, from `rules.extract_features`). `tests/test_textin.py` compares it with
the installed `agento_brain` when that is available. The template string written to `heads.json` is `INPUT_TEMPLATE`: the SAME
constant is used to render training text.
"""
from __future__ import annotations

import re
from typing import Any

INPUT_TEMPLATE = (
    "[lang={lang}][repo={repo}][ctx={ctx}][files_in_repo={files_in_repo}][start={start}]\n"
    "[prev_task={prev_task}][git_dirty={git_dirty}][mentions={mentions}]\n"
    "{text}"
)
HEAD_FRAC = 0.75

_PLACEHOLDER = re.compile(r"\{([A-Za-z_][A-Za-z0-9_]*)\}")
_ALIASES = {"ctx": ("ctx", "context_tokens", "contextTokens"), "start": ("start", "start_kind", "startKind")}
_A = "A-Za-z0-9_"
_FENCE_RE = re.compile(r"```[\s\S]*?(?:```|\Z)")
_FILE_RE = re.compile(
    rf"(?:[{_A}.-]+/)+[{_A}.-]+"
    rf"|[{_A}-]+\.(?:tsx?|jsx?|mjs|cjs|py|go|rs|java|kt|rb|php|cs|cpp|c|h|md|json|ya?ml|toml|sh|sql|css|html|lock)(?![{_A}])"
)


def _normalize(text: str) -> str:
    return text.lower().replace("ё", "е")


def prompt_lang(prompt: str) -> str:
    """`ru` / `en` / `other`, as `rules.extract_features(...).prompt_lang` (prose outside code fences, share of Cyrillic > 0.3)."""
    prose = _normalize(_FENCE_RE.sub(" ", prompt))
    cyr = sum(1 for ch in prose if "а" <= ch <= "я")
    lat = sum(1 for ch in prose if "a" <= ch <= "z")
    if cyr + lat == 0:
        return "other"
    return "ru" if cyr / (cyr + lat) > 0.3 else "en"


def mentions_files(prompt: str) -> int:
    return len({f.lower() for f in _FILE_RE.findall(_FENCE_RE.sub(" ", prompt))})


def compact_number(v: Any) -> str:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return str(v)
    n = float(v)
    if n < 1000:
        return str(int(n)) if n == int(n) else f"{n:g}"
    if n < 10_000:
        return f"{n / 1000:.1f}k".replace(".0k", "k")
    return f"{round(n / 1000)}k"


def join_text(text: "str | list[str]") -> str:
    """A list of prompts is joined with a blank line (CONTRACT.md)."""
    if isinstance(text, list):
        return "\n\n".join(str(t) for t in text)
    return str(text)


def _first(context: dict, names: tuple) -> Any:
    for n in names:
        if n in context and context[n] is not None:
            return context[n]
    return None


def header_fields(text: str, context: dict) -> dict:
    ctx = context or {}
    out: dict = {}
    lang, mentions = ctx.get("lang"), ctx.get("mentions")
    out["lang"] = str(lang if lang is not None else prompt_lang(text))
    out["mentions"] = str(mentions if mentions is not None else mentions_files(text))
    repo = ctx.get("repo", ctx.get("languages"))
    out["repo"] = ",".join(map(str, repo)) if isinstance(repo, (list, tuple)) and repo else (str(repo) if repo else "unknown")
    ctx_tokens = _first(ctx, _ALIASES["ctx"])
    out["ctx"] = compact_number(ctx_tokens) if ctx_tokens is not None else "unknown"
    fir = ctx.get("files_in_repo")
    out["files_in_repo"] = compact_number(fir) if fir is not None else "unknown"
    start = _first(ctx, _ALIASES["start"])
    if start is None and "is_session_start" in ctx:
        start = "session" if ctx["is_session_start"] else "mid"
    out["start"] = str(start) if start is not None else "unknown"
    prev = ctx.get("prev_task")
    if prev is None and "prev_task_was_heavy" in ctx:
        prev = "heavy" if ctx["prev_task_was_heavy"] else "light"
    out["prev_task"] = str(prev) if prev is not None else "none"
    out["git_dirty"] = str(ctx.get("git_dirty", 0))
    return out


def render(template: str, text: "str | list[str]", context: "dict | None" = None) -> str:
    body = join_text(text)
    fields = header_fields(body, context or {})
    extra = {k: str(v) for k, v in (context or {}).items() if isinstance(v, (str, int, float)) and not isinstance(v, bool)}

    def sub(m: "re.Match[str]") -> str:
        name = m.group(1)
        if name == "text":
            return body
        if name in fields:
            return fields[name]
        return extra.get(name, "unknown")

    return _PLACEHOLDER.sub(sub, template)


def head_tail(ids: list, max_len: int, head_frac: float = HEAD_FRAC) -> list:
    """Keep the first ceil(head_frac*max_len) and the last remainder; special tokens at both ends survive."""
    if len(ids) <= max_len:
        return ids
    head = int(max_len * head_frac + 0.9999)
    head = min(max(head, 1), max_len - 1)
    return ids[:head] + ids[len(ids) - (max_len - head) :]
