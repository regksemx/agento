"""The four decisions agento's System 1 makes (docs/spec-phase-2-training.md section 4) and their label encodings.

Pure Python, no third-party imports: export, metrics and tests use it without torch.
"""
from __future__ import annotations

TIERS = ("haiku", "sonnet", "opus")  # cheapest first: the index is the cost rank
EFFORTS = ("low", "medium", "high")  # cheapest first
HEADS = ("tier", "effort", "plan_first", "delegate_explore")
HEAD_OPTIONS = {
    "tier": TIERS,
    "effort": EFFORTS,
    "plan_first": ("no", "yes"),  # brain/CONTRACT.md labels; Laya noul order [false, true] = index 0/1, index 1 = yes
    "delegate_explore": ("no", "yes"),
}
HEAD_SIZES = {h: len(o) for h, o in HEAD_OPTIONS.items()}
LAYA_TYPE = {"tier": "choice", "effort": "score", "plan_first": "noul", "delegate_explore": "noul"}

# Laya question definitions. Written for `laya.agent.Agent._check_question`: a choice takes a label -> description
# dict (no boolean-word labels, README "Honest limits"), a score a list of level descriptions, a noul needs
# `criteria` keyed true/false (a criteria-less noul answers "no" whatever the state on the English checkpoint).
LAYA_QUESTIONS = {
    "tier": {
        "type": "choice",
        "instructions": (
            "Which is the cheapest Claude model that would still complete this coding-agent task "
            "correctly, without extra user corrections?"
        ),
        "criteria": {
            "haiku": "a question, lookup or tiny mechanical edit; no real reasoning or multi-file work",
            "sonnet": "ordinary implementation, bug fix, refactor or explanation within a few files",
            "opus": "hard task: architecture, many files, subtle debugging, long agentic work or high risk",
        },
    },
    "effort": {
        "type": "score",
        "instructions": "How much reasoning effort does this task need?",
        "criteria": [
            "low effort: answer or act directly, almost no deliberation",
            "medium effort: some planning and a check of the result",
            "high effort: deep multi-step reasoning, careful verification, many iterations",
        ],
    },
    "plan_first": {
        "type": "noul",
        "instructions": "Should the strongest model write an architecture or implementation plan before any code is written?",
        "criteria": {
            "true": "yes, the task is large or ambiguous enough that a plan should come first",
            "false": "no, the task can be started directly",
        },
    },
    "delegate_explore": {
        "type": "noul",
        "instructions": "Should codebase exploration be delegated to a cheap scout subagent before the main work starts?",
        "criteria": {
            "true": "yes, the task needs broad searching and reading of unfamiliar code first",
            "false": "no, the relevant code is known or the task needs no exploration",
        },
    },
}

# Label weights per source (spec section 2): L2 replay is gold, L1 judge is soft, L0 trajectory is weak.
SOURCE_WEIGHT = {"L2": 1.0, "L1": 0.6, "L0": 0.3}
SOURCE_RANK = {"L2": 2, "L1": 1, "L0": 0}  # higher wins
# plan_first / delegate_explore have no L0 field of their own; they are derived from trajectory flags,
# so they count for less than a real L0 label until a judge supplies them.
DERIVED_WEIGHT_FACTOR = 0.5
