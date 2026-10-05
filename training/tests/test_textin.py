import pytest

from agento_train.textin import INPUT_TEMPLATE, compact_number, head_tail, mentions_files, prompt_lang, render


def test_compact_and_lang_and_mentions():
    assert [compact_number(x) for x in (950, 1200, 82000)] == ["950", "1.2k", "82k"]
    assert prompt_lang("Исправь баг") == "ru" and prompt_lang("fix the bug") == "en" and prompt_lang("1234") == "other"
    assert prompt_lang("```python\nпривет мир привет\n``` fix the bug") == "en"
    assert mentions_files("see src/a.ts and src/a.ts and README.md") == 2


def test_render_defaults_and_single_pass():
    out = render(INPUT_TEMPLATE, "fix {lang} bug", {})
    assert out.startswith("[lang=en][repo=unknown][ctx=unknown][files_in_repo=unknown][start=unknown]\n[prev_task=none][git_dirty=0][mentions=0]\n")
    assert out.endswith("fix {lang} bug")
    assert render("{text}", ["a", "b"]) == "a\n\nb"


def test_head_tail_matches_contract():
    ids = list(range(100))
    out = head_tail(ids, 20)
    assert len(out) == 20 and out[:15] == ids[:15] and out[15:] == ids[-5:]
    assert head_tail(ids[:10], 20) == ids[:10]


def test_matches_installed_brain():
    brain = pytest.importorskip("agento_brain.textin")
    ctx = {"repo": ["kotlin", "gradle"], "ctx": 82000, "start": "cold", "prev_task": "heavy"}
    for prompt in ["Исправь баг в src/app.ts", "fix `x` in README.md ```a/b.py```", ["one", "two"], "1234"]:
        assert render(INPUT_TEMPLATE, prompt, ctx) == brain.render(INPUT_TEMPLATE, prompt, ctx)
        assert render(INPUT_TEMPLATE, prompt, {}) == brain.render(INPUT_TEMPLATE, prompt, {})
    assert head_tail(list(range(97)), 40) == brain.head_tail(list(range(97)), 40)
    assert brain.DEFAULT_TEMPLATE == INPUT_TEMPLATE
