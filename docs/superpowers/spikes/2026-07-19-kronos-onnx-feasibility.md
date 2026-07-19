## Kronos → ONNX → `ort` feasibility spike (Task 13)

**Date:** 2026-07-19
**Status:** exploratory spike, complete within timebox. No product code changed.

## Verdict: **GO**

Kronos's tokenizer and transformer core export cleanly to ONNX with **zero unsupported-operator
failures**, and the exported graphs, loaded and run through Rust's `ort` crate, numerically match
the PyTorch reference to within **2.7e-5 absolute error** on raw logits and **6e-7 relative error**
(for the `|value| > 1` slice) on the final reconstructed OHLCV forecast — three orders of magnitude
inside the brief's `1e-3` relative-tolerance target. The greedy (`top_k=1`) argmax decision, which
is what the model's own reference regression test uses, matched exactly in every case tested.

**One real caveat drives the integration design, not the verdict:** naive `dynamic_axes` ONNX export
(needed because the autoregressive loop's context length grows by one token per step) does *not*
generalize safely — it exports without error but produces large numeric drift (and one outright
argmax flip) at sequence lengths other than the trace-time length. The fix is a known, solved
pattern (fixed-shape graphs / padded-to-`max_context` buffers), not a research risk — see
"Catalog-plan recommendation" below.

Also notable: the design doc (§6.2) anticipated needing to **reimplement the BSQ tokenizer's
quantization step as plain Rust math**. That turned out to be unnecessary — the tokenizer's
`encode`/`decode` exported natively and its integer token IDs matched the PyTorch reference
**bit-exactly**. It can stay inside the ONNX graph.

---

## 1. Reference inference (Step 1) — confirmed working, CPU-only

- Cloned `github.com/shiyu-coder/Kronos` (MIT license) fresh.
- The repo ships its own golden regression test (`tests/test_kronos_regression.py`,
  `tests/data/regression_input.csv` — 2,500 rows of real 5-minute A-share OHLCV bars — and
  pre-computed `regression_output_{256,512}.csv`), pinned to exact HF revisions. This is a
  stronger, more reproducible reference than a hand-rolled sample, so it was used as-is instead of
  a synthetic fixture.
- **Both** of the repo's own regression tests (`context_len=256` and `context_len=512`,
  `pred_len=8`, greedy `top_k=1, top_p=1.0` decoding) **passed** in a clean environment:
  `pytest tests/test_kronos_regression.py` → `2 passed`.
- Model: **Kronos-small** (24.7M params, `NeoQuasar/Kronos-small`, revision
  `901c26c1332695a2a8f243eb2f37243a37bea320`) + **Kronos-Tokenizer-base**
  (`NeoQuasar/Kronos-Tokenizer-base`, revision `0e0117387f39004a9016484a186a908917e22426`).
  Combined checkpoint download: **~109 MB** (94 MB model + 15 MB tokenizer, safetensors, fp32).
  Kronos-mini (4.1M) + Kronos-Tokenizer-2k would be considerably smaller; not independently
  re-tested, but it's the same module classes, so the export/ort results below are expected to
  transfer directly.
- Runs entirely on CPU (`torch.backends.mps`/`cuda` not required; ran on Apple Silicon CPU-only in
  ~20s for both regression cases including model load).
- Runtime deps to *reproduce the reference* (not needed at ship time — see §4): Python 3.10+,
  `torch>=2.0` (tested with 2.13.0 CPU wheel), `numpy`, `pandas`, `einops==0.8.1`,
  `huggingface_hub==0.33.1`, `safetensors==0.6.2`.

## 2. Architecture read + export attempt (Step 2)

Read `model/kronos.py` and `model/module.py` directly (not just the README) to find the actual
inference-time data flow:

- **`KronosTokenizer.encode`**: `Linear → N encoder TransformerBlocks → Linear → BSQuantizer`. The
  "quantization step" is `torch.where(z>0, 1, -1)` (straight-through, irrelevant under `no_grad`)
  plus bit-packing via shifts/sums (`bits_to_indices`) — plain comparison/arithmetic ops, no custom
  op, no control flow.
- **`KronosTokenizer.decode`**: bits → `Linear → N decoder TransformerBlocks → Linear`.
- **`Kronos.decode_s1`** / **`Kronos.decode_s2`**: the transformer core (`RMSNorm`, RoPE
  self-attention via `F.scaled_dot_product_attention(..., is_causal=True)`, SwiGLU feed-forward,
  a small `DependencyAwareLayer` cross-attention "dual head"). Pure tensor-in/tensor-out, no branch
  on tensor *values*.
- **The autoregressive loop itself** (`auto_regressive_inference` in `kronos.py`) is plain Python:
  a `for i in range(pred_len)` loop that slides a token buffer and calls `decode_s1`/`decode_s2`
  once per new token, with `top_k_top_p_filtering` + `torch.multinomial` sampling **outside** the
  model's `forward`. This confirms the brief's suspicion: the loop was never a candidate for
  single-graph capture, in this reference implementation or in anyone else's — it must be
  reimplemented as host-language control flow regardless of which language runs the model.

Wrapped the four inference-relevant sub-modules above in plain `nn.Module` adapters and ran
`torch.onnx.export(..., opset_version=18, dynamo=False)` at the fixed shape matching the regression
fixture (`ctx_len=256`, batch=1):

| Sub-graph | Export result | File size |
|---|---|---|
| `tokenizer.encode` (x → s1_ids, s2_ids) | **OK**, no errors | 8.76 MB |
| `tokenizer.decode` (s1_ids, s2_ids → OHLCV) | **OK**, no errors | 8.76 MB |
| `Kronos.decode_s1` (transformer core, first head) | **OK**, no errors | 94.9 MB |
| `Kronos.decode_s2` (dependency-aware second head) | **OK**, no errors | 8.4 MB |

No unsupported operators, no custom-op registration needed, no graph breaks. The only warnings
were `TracerWarning`s about baking the traced `seq_len` in as a constant (RoPE's Python-side
`cos_cached`/`sin_cached` memoization, and a shape assert in the BSQ quantizer) — expected for a
fixed-shape trace, and the seed of the one real problem found next.

### Dynamic-shape export: exports without error, but is numerically unsafe

The autoregressive loop needs `decode_s1` at every context length from 256 up to 263 (`ctx_len +
pred_len`). Re-exporting per-length works but is wasteful, so I tried the standard fix —
`dynamic_axes={"s1_ids": {1: "seq_len"}, ...}`. It exported without error. Running the *same*
exported graph at lengths other than the trace length (256) against PyTorch eager at that same
length:

| seq_len | max abs err | argmax match |
|---|---|---|
| 256 (trace length) | 5.4 | true |
| 257 | 5.7 | true |
| 260 | 6.2 | **false** |
| 263 | 7.7 | true |

Absolute errors of 5–8 (vs. 2.7e-5 for fixed-shape export) and one outright decision flip — this is
a **silent correctness bug**, not a hard failure, which is the dangerous version of the "dynamic
shapes" trouble spot the brief flagged. I isolated one candidate cause — `RotaryPositionalEmbedding`
memoizes `cos_cached`/`sin_cached` on a Python instance attribute keyed by a traced-as-constant
`seq_len` (`model/module.py:293-301`) — and patched it to always recompute from the live tensor
shape. That reduced but did **not** eliminate the drift (still ~5.0–5.9 abs error across lengths,
though argmax now agreed at all four tested lengths). Root cause not fully isolated within the
spike's timebox — likely a second dynamic-shape-sensitive spot in the causal/padding mask
construction. **Conclusion: don't use naive `dynamic_axes` export for this model without much more
validation.** The safe path (below) sidesteps the question entirely.

## 3. Rust `ort` load + run (Step 3/4) — confirmed working

Built a throwaway Cargo project (`ort = "2.0.0-rc.12"` with the `download-binaries` feature, which
pulled ONNX Runtime **v1.24.2** automatically; `ndarray = "0.17.2"`, `ndarray-npy = "0.10.0"` to
load the dumped reference tensors; Rust `1.95.0`). Loaded all four fixed-shape (`seq_len=256`)
`.onnx` files via `Session::builder()?.commit_from_file(...)`, ran them with `session.run(ort::inputs![...])`,
and diffed every output against the PyTorch-eager reference dumped to `.npy`:

| Graph | Comparison | Result |
|---|---|---|
| `tokenizer_encode.onnx` | s1_ids, s2_ids (int64) vs. PyTorch | **exact match** |
| `decode_s1.onnx` | s1_logits vs. PyTorch | max abs err **2.670e-5**, max rel err (`|v|>1`) **9.0e-6** |
| `decode_s1.onnx` | context vs. PyTorch | max abs err 1.431e-6, max rel err (`|v|>1`) 8.2e-7 |
| `decode_s1.onnx` | greedy argmax @ last position | **ort=941, python=941, match** |
| `decode_s2.onnx` | s2_logits vs. PyTorch | max abs err 2.670e-5, max rel err (`|v|>1`) 3.2e-6 |
| `tokenizer_decode.onnx` | reconstructed OHLCV (z) vs. PyTorch | max abs err 1.907e-6, max rel err (`|v|>1`) **6.0e-7** |

All comfortably inside the brief's `1e-3` relative-error target — the residual error is the
expected float32 kernel-ordering noise between PyTorch's and ONNX Runtime's CPU matmul/softmax
implementations, not a correctness problem. **This confirms `ort` in Rust can load and run
Kronos's tokenizer and transformer graphs and reproduce the Python reference.**

Scope note: this validates each fixed-shape sub-graph independently (one call per graph, matching
what a single step of the autoregressive loop needs). I did not additionally wire up the full
8-step generate-and-decode loop as a standalone Rust binary — at this point that is pure
control-flow plumbing around the already-validated `session.run()` calls (buffer bookkeeping +
argmax, both of which I already exercised in isolation), not a new feasibility question, and the
timebox was better spent chasing the dynamic-shape correctness bug above, which *was* a real open
question.

## 4. Facts relevant to bundling in a desktop app

- **Model size:** Kronos-small + Tokenizer-base ≈ 109 MB combined (fp32 safetensors). Kronos-mini +
  Tokenizer-2k (4.1M params) would be a small fraction of that — worth using as the shipped
  default if the forecast quality difference is acceptable; both are architecturally identical to
  what was tested here.
- **CPU-only:** confirmed — no CUDA/MPS required for either PyTorch reference or ONNX Runtime
  execution. Runs in seconds on a laptop CPU for a single 256-bar window.
- **Runtime dependency footprint (shipped app):** just the `.onnx` files + the `ort` crate + the
  ONNX Runtime shared library (~tens of MB, and `ort`'s `download-binaries` feature or a vendored
  copy handles this — no Python, no torch, no libtorch needed at runtime).
  Python/torch/einops/huggingface_hub are **build-time-only** tooling used once to export the
  `.onnx` files from the upstream checkpoints — they never ship in the Electron/Rust app.
- **Export tooling versions used (for reproducibility):** Python 3.12.13, `torch==2.13.0` (CPU
  wheel), `onnx==1.22.0`, `onnxruntime==1.27.0` (Python, used only to cross-check exports before
  going to Rust), `einops==0.8.1`, `huggingface_hub==0.33.1`, `safetensors==0.6.2`.
- **Rust side versions:** `cargo`/`rustc` 1.95.0, `ort = "2.0.0-rc.12"` (bundles ONNX Runtime
  **1.24.2**), `ndarray = "0.17.2"`, `ndarray-npy = "0.10.0"` (dev-only, for loading test fixtures).
- **Opset used:** 18 (legacy TorchScript-based `torch.onnx.export`, not the newer dynamo exporter —
  `dynamo=True` was not tried in this timebox; the legacy tracer already worked cleanly and is
  still fully supported in torch 2.13 alongside a deprecation warning pointing at the dynamo path
  for future PyTorch versions).

## 5. Catalog-plan recommendation

Build Kronos into the Rust sidecar as one more `Algorithm` via `ort`, per design §6.2, with this
specific split:

- **Export once, offline, at release-engineering time** (not at runtime): run the Python export
  script (kept in this spike, adaptable) to produce `.onnx` files for `tokenizer.encode`,
  `tokenizer.decode`, `Kronos.decode_s1`, `Kronos.decode_s2` from the chosen checkpoint
  (Kronos-mini or -small). Commit these `.onnx` files as build assets, the same way any other
  vendored model weight would ship.
- **Do not use `dynamic_axes` export** for `decode_s1`/`decode_s2` without further validation — it
  silently corrupts results at off-trace sequence lengths (§2 above). Two known-safe alternatives,
  either is fine:
  1. Export a small, bounded *set* of fixed shapes actually needed (the lookback window is fixed
     per instrument/timeframe choice, e.g. 256 or 512, and forecast horizons are typically small —
     a few dozen shapes at most, each ~90 MB for `decode_s1` if reusing the same weights... actually
     only the *graph*, not the weights, differs per shape, so this is cheap to generate but adds
     files); **or, preferred:**
  2. Export ONE graph at the model's `max_context` (512 for -small, 2048 for -mini) and always feed
     a full-length buffer, left-zero-padded for the not-yet-filled tail, with an explicit padding
     mask (the model's `decode_s1`/`decode_s2` already accept a `padding_mask` argument — plumb it
     through instead of passing `None`) — then read logits from the correct real position index.
     This is the standard fixed-shape pattern for static-graph autoregressive ONNX deployment and
     was not fully re-validated in this timebox (flagged as the first follow-up task if this spike
     is accepted).
- **The BSQ tokenizer needs no separate Rust reimplementation** — contrary to the design doc's a
  priori assumption, it exports natively into the ONNX graph and its integer token IDs matched the
  PyTorch reference bit-exactly. This simplifies the catalog plan versus what §6.2 anticipated.
- **Reimplement only the driver loop in Rust**, not any model math: buffer bookkeeping (append the
  newly generated token, slide the window once `max_context` is reached — same logic as
  `auto_regressive_inference` in `kronos.py`) and the sampling step. Since design §6.2 explicitly
  wants Kronos's forecast to be **deterministic** ("a deterministic function of its frozen weights
  plus the input sequence, not a source of randomness"), the natural choice is the same greedy
  (`top_k=1`) decoding the reference regression fixture itself uses — that reduces the Rust-side
  sampling step to a plain `argmax` over each step's logits, no RNG/multinomial crate required. If
  the optional temperature/top-p ensemble mode from the upstream `predict()` API is wanted later,
  it's a standard, small piece of code (softmax + cumulative-sum cutoff + one RNG draw per step) —
  not a blocker to today's GO verdict.
- **Registered as one `Algorithm`** whose `AlgoOutput` is a forecast band + conviction, presented
  as a labeled "model opinion" per design §6.2 — no architectural change needed there; this spike
  only affects the *implementation* of that one `Algorithm`, not the trait or aggregation layer.

## Reproducibility

- Kronos repo: `github.com/shiyu-coder/Kronos`, cloned fresh (no pinned commit hash captured for
  the repo itself, but the model files are pinned — see below — and the model source code read for
  this spike, `model/kronos.py` and `model/module.py`, is the code that runs when loading those
  pinned revisions).
- Checkpoints: `NeoQuasar/Kronos-small` @ `901c26c1332695a2a8f243eb2f37243a37bea320`,
  `NeoQuasar/Kronos-Tokenizer-base` @ `0e0117387f39004a9016484a186a908917e22426`.
- Sample window: the repo's own `tests/data/regression_input.csv` (2,500 rows, real 5-min A-share
  OHLCV), first 256 bars as context, next 8 bars as the forecast target — this is the repo
  maintainers' own golden fixture (`tests/data/regression_output_256.csv`), not a fixture invented
  for this spike.
- Reference forecast: reproduced exactly via `pytest tests/test_kronos_regression.py` (2 passed,
  `rtol=1e-5` against the maintainers' own pinned output).
- All errors quoted above are measured directly (scripts and dumped `.npy` reference tensors are in
  this spike's scratch directory, not committed to the repo).

## What was NOT covered (honest gaps, given the timebox)

- The full closed-loop multi-step (`pred_len=8`) forecast was not re-driven end-to-end inside a
  single Rust binary; each step's underlying `ort` call was validated in isolation instead (see
  scope note in §3). The remaining work is control-flow plumbing, not a new feasibility question.
- Kronos-mini/Tokenizer-2k (the smallest, most bundle-friendly checkpoint) was not independently
  re-tested — only Kronos-small/Tokenizer-base (the pair the upstream regression fixture pins).
  Same module classes, so results are expected to carry over, but not empirically confirmed here.
- The fixed-max-context-with-padding-mask approach (the recommended production pattern for
  variable-length autoregressive decoding without unsafe dynamic axes) was described but not
  implemented/validated in this spike.
- `torch.onnx.export(..., dynamo=True)` (the new default exporter going forward) was not tried; the
  legacy tracer already gave a clean, validated answer, so there was no need to within this
  timebox.
