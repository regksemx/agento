from agento_brain import textin


def test_compact_number():
    assert [textin.compact_number(x) for x in (0, 950, 1200, 82_000, 10_400, 2000)] == ["0", "950", "1.2k", "82k", "10k", "2k"]
    assert textin.compact_number("82k") == "82k"


def test_render_header_defaults_and_derivation():
    t = "[lang={lang}][repo={repo}][ctx={ctx}][start={start}][mentions={mentions}][x={nonsense}]\n{text}"
    out = textin.render(t, "поправь опечатку в src/a.ts", {"context_tokens": 82000, "repo": ["kotlin", "gradle"], "is_session_start": True})
    assert out.splitlines()[0] == "[lang=ru][repo=kotlin,gradle][ctx=82k][start=session][mentions=1][x=unknown]"
    assert out.endswith("\nпоправь опечатку в src/a.ts")
    bare = textin.render(textin.DEFAULT_TEMPLATE, "hello", {})
    assert "[prev_task=none]" in bare and "[git_dirty=0]" in bare and "[lang=en]" in bare


def test_render_does_not_reexpand_prompt_braces():
    assert textin.render("{text}|{lang}", "{lang} {ctx}", {"lang": "ru"}) == "{lang} {ctx}|ru"


def test_text_list_is_joined():
    assert textin.join_text(["a", "b"]) == "a\n\nb"


def test_head_tail_truncation():
    ids = list(range(100))
    out = textin.head_tail(ids, 20)
    assert len(out) == 20
    assert out[:15] == ids[:15] and out[15:] == ids[-5:]
    assert out[0] == 0 and out[-1] == 99  # CLS/SEP positions preserved
    assert textin.head_tail(ids[:20], 20) == ids[:20]
