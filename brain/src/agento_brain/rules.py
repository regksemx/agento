"""Python port of plugin/core/task.ts (`extractFeatures` + `classifyRules`, v1 rules).

Faithfulness notes (JS -> Python regex):
- JS `(?<![\\p{L}\\p{N}_])` (unicode) becomes `(?<!\\w)`; Python `\\w` on str is unicode-aware.
- JS `\\b`, `\\w` WITHOUT the `i` flag are ASCII-only, so those spots use explicit ASCII classes.
- JS `$` (no `m` flag) is end-of-string, so Python uses `\\Z`.
- `promptChars` counts UTF-16 code units like JS `String.length`.
Parity is checked against golden output produced by the real TS code (tests/golden_rules.json).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

RULES_RUN_ID = "rules-v1"

Entry = str | re.Pattern[str]

_A = "A-Za-z0-9_"  # JS ASCII \w


def _rx(pattern: str) -> re.Pattern[str]:
    return re.compile(pattern)


HEAVY_WORDS: list[Entry] = [
    # ru
    "архитектур",
    "спроектир",
    "проектирован",
    "распредел",
    "миграци",
    "мигрир",
    "производительн",
    "масштабир",
    "масштабируем",
    "многопоточ",
    "конкурентн",
    "дедлок",
    "взаимоблокир",
    "гонк",
    "утечк памят",
    "безопасност",
    "уязвимост",
    "микросервис",
    "консенсус",
    "идемпотентн",
    _rx(r"(?:от)?рефактор\S*\s+(?:\S+\s+){0,2}?(?:модул|систем|подсистем|архитектур|сервис|кодов\S* баз)"),
    # en
    "architect",
    "design$",
    "migrat",
    "distribut",
    "race$",
    "deadlock",
    "concurren",
    "multithread",
    "performance",
    "scalab",
    "microservice",
    "vulnerab",
    "consensus",
    "idempoten",
    "memory leak",
    "from scratch",
    _rx(rf"(?<![{_A}])refactor[{_A}]*\s+(?:\S+\s+){{0,3}}?(?:module|system|subsystem|architecture|codebase|service)"),
]

LIGHT_WORDS: list[Entry] = [
    # ru
    "опечатк",
    "переимен",
    "обнови верси",
    "обновить верси",
    "поправь текст",
    "исправь текст",
    "readme",
    "комментари",
    "форматир",
    "отформатир",
    "докстринг",
    "отступ",
    _rx(r"добав\S*\s+(?:\S+\s+){0,2}?лог"),
    # en
    "typo",
    "rename",
    "bump",
    "prettier",
    "lint",
    "docstring",
    "changelog",
    "comment$",
    "comments$",
    "format$",
    _rx(r"(?:update|upgrade)\s+(?:the\s+)?version"),
    _rx(rf"add\s+(?:a\s+|the\s+)?(?:\S+\s+){{0,2}}?log(?:ging|s)?(?![{_A}])"),
    _rx(r"fix\s+(?:the\s+)?(?:text|wording)"),
]

PLAN_WORDS: list[Entry] = [
    # ru
    "как лучше",
    "давай обсудим",
    "обсудим",
    "обсуд",
    "план",
    "подход$",
    "подхода$",
    "подходы$",
    "подходов$",
    "вариант",
    "продумай",
    "стратеги",
    "плюсы и минусы",
    "стоит ли",
    # en
    "plan$",
    "planning$",
    "approach",
    "options$",
    "brainstorm",
    "trade-off",
    "tradeoff",
    "pros and cons",
    "best way",
    "how should we",
    "let's discuss",
    "strategy",
]


def _compile(entries: list[Entry]) -> list[re.Pattern[str]]:
    out: list[re.Pattern[str]] = []
    for e in entries:
        if not isinstance(e, str):
            out.append(e)
            continue
        exact = e.endswith("$")
        stem = re.escape(e[:-1] if exact else e)
        out.append(re.compile(rf"(?<!\w){stem}" + (r"(?!\w)" if exact else "")))
    return out


_HEAVY_RE = _compile(HEAVY_WORDS)
_LIGHT_RE = _compile(LIGHT_WORDS)
_PLAN_RE = _compile(PLAN_WORDS)

_FENCE_RE = re.compile(r"```[\s\S]*?(?:```|\Z)")
_FILE_RE = re.compile(
    rf"(?:[{_A}.-]+/)+[{_A}.-]+"
    rf"|[{_A}-]+\.(?:tsx?|jsx?|mjs|cjs|py|go|rs|java|kt|rb|php|cs|cpp|c|h|md|json|ya?ml|toml|sh|sql|css|html|lock)(?![{_A}])"
)


def normalize(text: str) -> str:
    return text.lower().replace("ё", "е")


def _count_hits(res: list[re.Pattern[str]], text: str) -> int:
    return sum(1 for r in res if r.search(text))


@dataclass
class TaskFeatures:
    prompt_chars: int
    prompt_lang: str  # 'ru' | 'en' | 'other'
    has_code_block: bool
    mentions_files: int
    heavy: int
    light: int
    plan: int
    is_session_start: bool
    context_tokens: int


@dataclass
class TaskVerdict:
    tier: str
    effort: str
    confidence: float
    reasons: list[str] = field(default_factory=list)


def _js_len(s: str) -> int:
    return len(s.encode("utf-16-le", "surrogatepass")) // 2


def extract_features(prompt: str, *, context_tokens: int = 0, is_session_start: bool = False) -> TaskFeatures:
    no_fences = _FENCE_RE.sub(" ", prompt)
    prose = normalize(no_fences)
    cyr = sum(1 for ch in prose if "а" <= ch <= "я")
    lat = sum(1 for ch in prose if "a" <= ch <= "z")
    if cyr + lat == 0:
        lang = "other"
    else:
        lang = "ru" if cyr / (cyr + lat) > 0.3 else "en"
    files = {f.lower() for f in _FILE_RE.findall(no_fences)}
    return TaskFeatures(
        prompt_chars=_js_len(prompt),
        prompt_lang=lang,
        has_code_block="```" in prompt,
        mentions_files=len(files),
        heavy=_count_hits(_HEAVY_RE, prose),
        light=_count_hits(_LIGHT_RE, prose),
        plan=_count_hits(_PLAN_RE, prose),
        is_session_start=is_session_start,
        context_tokens=context_tokens,
    )


def classify_rules(f: TaskFeatures) -> TaskVerdict:
    """v1 rules: never answers 'haiku'."""
    heavy, light, plan = f.heavy, f.light, f.plan
    if light >= 1 and heavy == 0 and f.prompt_chars < 400:
        return TaskVerdict("sonnet", "medium", 0.7, [f"light keywords: {light}", f"short prompt: {f.prompt_chars} chars"])
    if heavy >= 1 or plan >= 1:
        reasons: list[str] = []
        if heavy >= 1:
            reasons.append(f"heavy keywords: {heavy}")
        if plan >= 1:
            reasons.append(f"planning keywords: {plan}")
        return TaskVerdict("opus", "high", 0.6, reasons)
    return TaskVerdict("sonnet", "high", 0.4, ["no strong signal"])
