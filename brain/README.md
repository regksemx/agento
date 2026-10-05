# agento-brain

Local System-1 router daemon for agento (spec T36). Python 3.11+, `onnxruntime` + `tokenizers` + `numpy`, stdlib HTTP server (no framework).
It answers "which model tier / effort / plan first / delegate exploration" in well under the plugin's 150 ms budget, over a unix socket.

- With a trained model dir (artifact contract: [CONTRACT.md](CONTRACT.md)) it serves the ONNX student.
- Without one it serves **rules-v1**, a faithful Python port of `plugin/core/task.ts` (`extractFeatures` + `classifyRules`), `model_run_id: "rules-v1"`.
  Parity is tested on 72 prompts against output of the real TS code (`tests/golden_rules.json`).

## Run

```sh
cd brain
uv venv && uv pip install -e '.[dev]'          # Python >= 3.11 (onnxruntime needs wheels for your version)
agento-brain serve                              # $AGENTO_HOME/brain.sock (AGENTO_HOME defaults to ~/.agento)
agento-brain serve --socket /tmp/b.sock --model-dir path/to/model
agento-brain serve --port 8765                  # loopback TCP instead (127.0.0.1 only)
agento-brain serve --rules                      # force the rules fallback
agento-brain check path/to/model                # validate an artifact dir
```

Model selection: `--model-dir` > `$AGENTO_BRAIN_MODEL_DIR` > `$AGENTO_HOME/brain/model` (if it has `heads.json`) > rules-v1.
An explicitly given model dir that violates the contract is a hard error (exit 2), never a silent fallback.

Socket mode: parent dir created `0700`, socket `0600`, stale socket (nobody listening) removed, a live one refused, PID file `$AGENTO_HOME/brain.pid`,
SIGTERM/SIGINT stop gracefully and remove socket + PID file. One ORT session guarded by a lock, intra-op threads `min(4, cpus)`, warmed up at start.

```sh
curl --unix-socket ~/.agento/brain.sock http://localhost/healthz
curl --unix-socket ~/.agento/brain.sock http://localhost/v1/route -d '{"text":"fix the typo in README","context":{"start":"session"}}'
```

## Get the published model

```sh
agento-brain fetch                 # latest published model -> $AGENTO_HOME/brain/model (sha256 + contract checked)
agento-brain fetch opus-v1         # a named one (see src/agento_brain/models.json)
agento-brain fetch https://…/m.tar.gz --sha256 <hex>   # any archive of the four contract files
```

The previous model is kept as `model.prev`; a failed download or a model that breaks the contract changes nothing.

## Install as a service (writes files only)

```sh
agento-brain install [--model-dir DIR] [--source PATH|PKG] [--skip-venv]
```

Creates `$AGENTO_HOME/brain/.venv` (uv if available, else `python -m venv`, installs this checkout) and writes
`~/Library/LaunchAgents/dev.agento.brain.plist` (macOS) or `~/.config/systemd/user/agento-brain.service` (Linux). It then **prints** the
`launchctl bootstrap ...` / `systemctl --user enable --now ...` commands; it never loads or enables anything itself.

## Endpoints

All JSON. Errors: `{"error": {"code", "message"}}` with 400 (bad input / unknown question), 404, 405, 413 (>1 MiB), 500.

### `POST /v1/route`
```json
{"text": "...", "context": {"context_tokens": 82000, "repo": ["kotlin"], "start": "session"}}
```
-> `{"tier","effort","plan_first","delegate_explore","confidence","abstain","latency_ms","model_run_id"}` (rules also add `"reasons"`).
`confidence` = calibrated max-probability of `tier`; `abstain` per `thresholds.abstain` (rules: always `false`; the plugin applies its own threshold).
`text` may be a string or a list of prompts.

### `POST /v1/systemone` (Jev/Laya-style typed decisions)
```json
{"state": {"text": "...", "context": {...}},
 "questions": {"tier": {"type": "choice"}, "effort": {"type": "score"},
               "plan_first": {"type": "noul"}, "delegate_explore": {"type": "noul"}},
 "min_confidence": 0.7}
```
Question names are head names (or set `"head"` to alias: `{"type":"choice","head":"tier","options":["sonnet","opus"]}`; `options`/`levels` restrict and renormalize).
`state` may also be flat (`{"text": ..., "start": ...}`: every non-`text` key is a header field). Response:
```json
{"answers": {
   "tier":   {"type":"choice","label":"sonnet","argmax":"sonnet","probabilities":{"haiku":0.1,"sonnet":0.7,"opus":0.2},"confidence":0.7,"abstained":false,"min_confidence":0.7},
   "effort": {"type":"score","level":"medium","expected":1.1,"levels":["low","medium","high"],"distribution":{...},"confidence":0.6,"abstained":false,"min_confidence":0.7},
   "plan_first": {"type":"noul","p_true":0.2,"answer":false,"confidence":0.8,"abstained":false,"min_confidence":0.7}},
 "usage": {"input_tokens": 41, "output_tokens": 0}, "model_run_id": "...", "latency_ms": 3.2}
```
Abstention: `min_confidence` (request-level, per-question overrides) vs `confidence` (choice/score: modal probability; noul: `max(p, 1-p)`).
When abstaining, `abstained: true` and `label`/`level`/`answer` are `null` (`argmax` keeps the would-be label). `noul` requires a binary head; `choice`/`score` work on any head.
`score.expected` is the probability-weighted index into `levels` (0..n-1).

NOTE: the exact Laya/Jev response field names (`answers`, `label`, `probabilities`, `abstained`, ...) were reconstructed from the project docs, not from the Laya source;
the whole mapping lives in `service.py` (`_answer_choice/_answer_score/_answer_noul`, `systemone`) and is easy to adjust.

### `GET /healthz`
`{"ok", "model_run_id", "backend": "onnx"|"rules", "loaded_at", "p50_ms", "p95_ms", "requests", "version"}` (latency over the last 1024 requests, service time excl. socket I/O).

## Tests

```sh
uv pip install -e '.[dev]' && pytest -q
```
Generates a tiny ONNX model (hashed-bag-of-words style linear heads built with the `onnx` helper API) + tiny `tokenizer.json`; covers contract validation,
text template/truncation, all three question types + abstention, `/v1/route`, unix-socket round trip, SIGTERM lifecycle, stale-socket handling, install output, rules parity, latency stats.
