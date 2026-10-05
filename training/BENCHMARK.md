# Student latency / size benchmark

Question: which encoder should the distilled student be? The plugin's budget is ~100-400 ms per classification at task start;
the previous default (`jhu-clsp/ettin-encoder-150m`, seq 512, fp32, batch 1) measured p50 ~ 320 ms, too slow.

Recommendation criteria: p50 <= 60 ms at seq 256 with 4 threads on the dev Mac, a multilingual tokenizer (prompts are mostly
Russian), file <= 300 MB.

**Result: default student = `intfloat/multilingual-e5-small`, `--student-max-len 256`, word-embedding table stored as fp16.**
35 ms p50 at seq 256 (4 threads), 279 MB, 0.27 tokens per Russian char. Runner-up / first thing to A/B once real labels exist:
`jhu-clsp/mmBERT-small` (62 ms, 367 MB). `jhu-clsp/ettin-encoder-150m` stays available via `--student` (use `--student-max-len 512`).

## Setup

Apple M5 (10 cores), macOS, onnxruntime 1.30.0 (CPUExecutionProvider), torch 2.14.1, transformers 5.18.0, opset 17.
Every model is built with `distill.build_student` (encoder + mean pool + trunk + 4 heads, **random init**: latency does not depend
on weights) and exported with `distill.export_onnx` (the pipeline's own path, TorchScript exporter, dynamic batch and seq).
Batch 1, `attention_mask` all ones, random token ids at exactly the stated length (no padding). Each number below is the median of
3 fresh sessions x 40 runs (6 warmup), p50 / p95 in ms. Small models on this machine jitter up to ~2x between sessions
(macOS core scheduling), so differences under ~30% between neighbours are noise; ORT_ENABLE_ALL (the default) is used.
ModernBERT-base and mmBERT-base were measured once (60 runs), not 3 sessions.

## Results (fp32 compute, ONNX)

Size: `fp32` is the file as exported; `emb-fp16` is the same graph with the word-embedding table stored as fp16 and cast to fp32
after the lookup (`distill.shrink_embeddings_fp16`, now the default; compute and latency unchanged, see below).
Params: total (of which word embeddings).

| model | params | fp32 MB | emb-fp16 MB | 4 thr, seq 128 | 4 thr, seq 256 (p50/p95) | 4 thr, seq 512 | 1 thr, seq 128 | 1 thr, seq 256 | 1 thr, seq 512 | ru tok/char | meets criteria |
|---|---|---|---|---|---|---|---|---|---|---|---|
| ettin-encoder-17m | 17M (13M) | 68 | 42 | 3.1 | 10.5 / 10.6 | 24 | 6.4 | 17 | 44 | 0.51 | no: English-only |
| ettin-encoder-32m | 32M (19M) | 128 | 90 | 13.0 (5.8 in another run) | 22 / 25 | 64 | 14 | 41 | 100 | 0.51 | no: English-only |
| ettin-encoder-68m | 68M (26M) | 274 | 223 | 31 | 61 / 73 | 166 | 47 | 78 | 265 | 0.51 | no: English-only, 61 ms |
| ettin-encoder-150m (old default) | 150M (39M) | 599 | 522 | 57 | 121 / 132 | 318 | 94 | 206 | 522 | 0.51 | no: 121 ms, 599 MB, English-only |
| ModernBERT-base | 150M (39M) | 599 | - | 65 | 125 / 182 | 316 | 104 | 193 | 506 | 0.51 | no (same as 150m) |
| mmBERT-base | 307M (197M) | 1231 | - | 61 | 129 / 132 | 314 | 95 | 208 | 525 | 0.27 | no: 129 ms, 1.2 GB |
| mmBERT-small | 141M (98M) | 563 | 367 | 30 | 62 / 71 | 166 | 42 | 79 | 251 | 0.27 | borderline: 62 ms, 367 MB |
| **multilingual-e5-small** | 118M (96M) | 471 | **279** | 19 | **35 / 40** | 113 | 19 | 67 | 184 | 0.27 | **yes** |

Notes:
- Latency is dominated by the transformer body, not the vocabulary: e5-small has 12 layers x 384 hidden (21M non-embedding
  params), mmBERT-small 22 layers x 384, ettin-150m / ModernBERT-base 22 layers x 768.
- Roughly linear in seq length, so a typical short prompt is much cheaper than the table's seq 256 / 512 (e5-small: seq 64 ~ 6 ms,
  seq 128 ~ 19 ms).
- Multilingual models carry a 250k-token embedding table (e5-small: 96M of 118M params), hence the large fp32 file despite the
  small compute; storing that lookup table in fp16 removes ~190 MB (max logit difference vs fp32 <= 1.6e-4 on random inputs; the
  pipeline's ONNX-vs-torch agreement gate still runs on the shrunk file, e2e check: agreement 1.0000).

### Tokenization (tokens per character, no special tokens, 4 Russian + 4 English + 1 mixed sample sentences written for this test)

| tokenizer | Russian | English | mixed ru + code paths | ~tokens per RU sample (~120 chars) | per EN sample |
|---|---|---|---|---|---|
| Ettin / ModernBERT (BPE, 50k, English) | 0.509 | 0.200 | 0.417 | 67.8 | 27.2 |
| mmBERT (Gemma 2 tokenizer, 256k) | 0.274 | 0.199 | 0.314 | 36.5 | 27.0 |
| multilingual-e5-small (XLM-R SentencePiece, 250k) | 0.265 | 0.233 | 0.359 | 35.2 | 31.8 |

Ettin spends ~1.9x more tokens on Russian (byte-level fallback), so at equal seq it sees half the text and costs twice per
character; it is also English-only pretraining. A 256-token window holds ~930 Russian chars with the multilingual tokenizers
vs ~500 with Ettin (the header takes ~50 tokens).

## What the daemon does (dynamic shapes)

`brain/CONTRACT.md` and `brain/src/agento_brain/backends.py`: batch 1, **no padding**; the daemon renders the template, tokenizes,
head/tail-truncates to `max_len` (75% head / 25% tail, special tokens kept) and feeds `[1, len]` ids with an all-ones mask. Warmup
runs lengths 16, 16 and `max_len`. The ONNX has dynamic `batch`/`seq`, so short inputs are genuinely cheaper. Padding is not free
and the attention mask does not skip compute: a real 128-token input padded to 512 costs the same as 512
(e5-small 111 ms vs 19 ms unpadded; mmBERT-small 161 vs 30; ettin-150m 371 vs 57). Do not pad in the daemon.

## ORT graph optimizations (seq 256, 4 threads, single session, p50 ms)

| model | DISABLE_ALL | BASIC | EXTENDED | ALL (default) | saved optimized model, loaded with ALL |
|---|---|---|---|---|---|
| multilingual-e5-small | 42.2 | 36.3 | 35.0 | 35.1 | 35.7 |
| mmBERT-small | 66.2 | 63.7 | 61.5 | 62.6 | 60.8 |
| ModernBERT-base | 125.6 | 121.4 | 119.9 | 124.5 | 118.7 |

The default level already captures the gain (~5% for the ModernBERT family, ~20% for BERT-style e5). Saving the optimized graph
(`optimized_model_filepath`) gives the same steady-state latency and the same file size (+-0.1%); it only skips the optimization
pass at load (a one-off, not worth shipping a hardware-specific graph). No change made.

## fp16 on CPU (whole graph, `convert_float_to_float16`, keep fp32 inputs/outputs; seq 256, 4 threads, p50 ms)

| model | fp32 | fp16 | fp16 file MB |
|---|---|---|---|
| ettin-17m | 10.5 | 20.1 | 34 |
| ettin-32m | 22 | 40.5 | 64 |
| ettin-68m | 61 | 118 | 138 |
| ettin-150m | 121 | 329 | 300 |
| mmBERT-small | 62 | 129 | 282 |
| multilingual-e5-small | 35 | 80.5 | 236 |

fp16 is 1.8-2.7x **slower** on CPU (no native fp16 kernels in ORT's CPU provider on this machine; Cast nodes everywhere), only the
size halves. Not used. The embedding-table-only fp16 (a Gather + Cast) is the part that is free: it is what ships.
INT8 stays the pipeline's static-QDQ option behind its agreement/ECE gate (not benchmarked here: needs trained weights to be
meaningful).

## Recommendation

1. **Default student: `intfloat/multilingual-e5-small`, max_len 256, embeddings fp16.** The only candidate that meets all three
   criteria: 35 ms p50 (40 ms p95) at seq 256 / 4 threads (19 ms with 1 thread at seq 128, 67 ms with 1 thread at seq 256), 279 MB, XLM-R tokenizer with
   0.27 tokens per Russian char. Even seq 512 (113 ms) fits the 100-400 ms budget if longer prompts turn out to matter
   (`--student-max-len 512`; the teacher itself sees up to 840 tokens).
2. **Upgrade path: `jhu-clsp/mmBERT-small`** (`--student jhu-clsp/mmBERT-small`): a modern multilingual MLM encoder (8k context,
   same Gemma tokenizer efficiency), but 22 layers: ~62 ms at seq 256 (misses the 60 ms bar by noise), 367 MB. It is the
   fallback if e5-small cannot load, and the one to A/B on the test split when real labels exist.
3. Ettin 17m/32m are the fastest (10-22 ms at 256) and small, but English-only with 2x Russian token cost: only for an
   English-only deployment. Ettin 68m/150m and ModernBERT-base cannot meet the latency bar at seq 256 and are English-only.
4. mmBERT-base (1.2 GB, 129 ms at 256) is out.

Caveat: this is a latency/size study on random-init weights. Nothing here measures accuracy: with ~600 mostly-L0-labelled tasks,
the first real signal is the student-vs-teacher agreement and test metrics in `report.md`. If e5-small underperforms mmBERT-small
by more than the noise there, take the 25 ms hit.

Reproduce a row: build with `distill.build_student(name)`, `distill.export_onnx(model, path)`, optionally
`distill.shrink_embeddings_fp16(path)`, then time `InferenceSession.run` with `intra_op_num_threads` 4 or 1.
