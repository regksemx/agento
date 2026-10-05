"""Model input text: header line + prompt, rendered from heads.json `input_template`.

Template placeholders are `{name}`. `{text}` is the prompt. Every other name is a header field read from the
request `context` (missing -> a documented default, never an error). Names with no known default render as
"unknown", so a template written by the training side can never crash the daemon.
"""

from __future__ import annotations

import re
from typing import Any

from . import rules

DEFAULT_TEMPLATE = (
    "[lang={lang}][repo={repo}][ctx={ctx}][files_in_repo={files_in_repo}][start={start}]\n"
    "[prev_task={prev_task}][git_dirty={git_dirty}][mentions={mentions}]\n"
    "{text}"
)

_PLACEHOLDER = re.compile(r"\{([A-Za-z_][A-Za-z0-9_]*)\}")

# ctx / context_tokens, files_in_repo are rendered compactly ("82k", "1.2k") like the spec example.
_ALIASES = {"ctx": ("ctx", "context_tokens", "contextTokens"), "start": ("start", "start_kind", "startKind")}


def compact_number(v: Any) -> str:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return str(v)
    n = float(v)
    if n < 1000:
        return str(int(n)) if n == int(n) else f"{n:g}"
    if n < 10_000:
        return f"{n / 1000:.1f}k".replace(".0k", "k")
    return f"{round(n / 1000)}k"


def join_text(text: str | list[str]) -> str:
    if isinstance(text, list):
        return "\n\n".join(str(t) for t in text)
    return str(text)


def _first(context: dict[str, Any], names: tuple[str, ...]) -> Any:
    for n in names:
        if n in context and context[n] is not None:
            return context[n]
    return None


def header_fields(text: str, context: dict[str, Any]) -> dict[str, str]:
    """All known header fields as strings, derived from `context` with defaults/derivations."""
    ctx = context or {}
    out: dict[str, str] = {}

    lang = ctx.get("lang")
    mentions = ctx.get("mentions")
    if lang is None or mentions is None:
        feats = rules.extract_features(text)
        if lang is None:
            lang = feats.prompt_lang
        if mentions is None:
            mentions = feats.mentions_files
    out["lang"] = str(lang)
    out["mentions"] = str(mentions)

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


def render(template: str, text: str | list[str], context: dict[str, Any] | None = None) -> str:
    body = join_text(text)
    fields = header_fields(body, context or {})
    extra = {k: str(v) for k, v in (context or {}).items() if isinstance(v, (str, int, float)) and not isinstance(v, bool)}

    def sub(m: re.Match[str]) -> str:
        name = m.group(1)
        if name == "text":
            return body
        if name in fields:
            return fields[name]
        return extra.get(name, "unknown")

    # single pass, so `{...}` sequences inside the prompt are never re-expanded
    return _PLACEHOLDER.sub(sub, template)


def head_tail(ids: list[int], max_len: int, head_frac: float = 0.75) -> list[int]:
    """Keep the first ceil(head_frac*max_len) and the last remainder; special tokens at both ends survive."""
    if len(ids) <= max_len:
        return ids
    head = int(max_len * head_frac + 0.9999)
    head = min(max(head, 1), max_len - 1)
    return ids[:head] + ids[len(ids) - (max_len - head) :]
