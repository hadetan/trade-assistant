# Moirai-2.0-R-small → ONNX → fixed-shape quantile forecast feasibility spike (Task 3)

**Date:** 2026-07-20
**Status:** exploratory spike, complete within timebox. No product code changed. No git
commits made (per task scope); no cargo/Rust builds run.

## Verdict: **GO**

All four required GO-criteria pass, with margin:

| # | Criterion | Result |
|---|---|---|
| (a) | Exported graph passes `onnx.checker.check_model` | **PASS** |
| (b) | No dynamic-shape control-flow ops (`Loop`/`If`) in the graph | **PASS** — 0 `Loop`, 0 `If` out of 1,004 nodes |
| (c) | Quantile head (`ResidualBlock`) + final `[num_predict_token, quantiles, patch_size]` reshape present as STATIC ops | **PASS** — 57 static `Reshape` nodes, static graph output shape `[1, 4, 9, 16]` |
| (d) | Cross-validates vs. PyTorch eager, max rel err < 1e-3 | **PASS** — **8.844e-08** (fixture window), **9.761e-08** (independent second window) |

ONNX file: **43.9 MB** (46,042,963 bytes), opset 18, single input `closes: [1,512]` f32 →
single output `quantile_forecast: [1,4,9,16]` f32. **Two** export-only patches were required
(both confirmed behaviorally neutral — bit-identical eager output before/after); the specific
SDPA `is_causal`+`attn_mask` conflict that hit Kronos was checked for and, per the source, does
**not** occur here — see §3.

This is a materially better outcome than the dossier's "harder than Kronos, no prior art"
framing anticipated going in: zero prior ONNX export of any Moirai model exists anywhere, so
every finding below (the exact op that breaks, the exact patch, the exact I/O contract) is
first-of-its-kind for this model family.

---

## 1. Setup

- venv: reused `.../scratchpad/kronos-venv` (Python 3.12.13, `torch==2.13.0` CPU,
  `onnx==1.22.0`, `onnxruntime==1.27.0` — all as pinned by the Kronos spike). Added one new
  package: `jaxtyping==0.3.11` (pure-Python type-annotation library `uni2ts` uses throughout;
  no other new dependency was needed — see §2).
  - **Shared-venv caveat, for the record:** this venv is explicitly shared across all three
    parallel model spikes this cycle. Between two of my own runs, `huggingface_hub` moved from
    0.33.1 → 1.24.0 and `safetensors` from 0.6.2 → 0.8.0 in the venv, almost certainly from a
    concurrent sibling task's `pip install` (not anything this spike ran — the only install
    this spike issued was `pip install jaxtyping`, which has no such transitive dependency).
    `torch`/`onnx`/`onnxruntime` were unaffected, and this spike's export + validation passed
    cleanly on both sides of that change, so it didn't cost anything here — but it's a real
    concurrency risk worth flagging for the catalog-plan write-up: parallel spikes mutating a
    shared venv can silently shift each other's dependency versions mid-run.
- Cloned `github.com/SalesforceAIResearch/uni2ts` fresh into
  `scratchpad/spike-moirai/uni2ts`, checked out tag `2.0.0` (commit
  `8062ef5a5660d2fea395fd1288ec9c397396c168`) — matches the `uni2ts==2.0.0` PyPI release.
- Model: `Salesforce/moirai-2.0-R-small`, HF snapshot revision
  `30f43ff08c8494f4943ae1521e9d4e94a0fbb389`, downloaded (unauthenticated, public repo) via
  `Moirai2Module.from_pretrained(...)` (the class subclasses
  `huggingface_hub.PyTorchModelHubMixin`).
- Confirmed exact config from the live HF download (matches the dossier bit-for-bit):
  `d_model=384, d_ff=1024, num_layers=6, patch_size=16, max_seq_len=512,
  num_predict_token=4, scaling=True, quantile_levels=[0.1..0.9] (9 levels)`,
  **n_params = 11,387,208 (11.4M)**.
- **CC-BY-NC-4.0 acceptance restated (Q1, decided):** the brief records this as already decided
  by the human for personal/non-commercial use; this spike proceeded on that basis without
  re-litigating it. `uni2ts` the code repo is Apache-2.0; only the HF weights carry the NC term.

## 2. Avoiding the GluonTS/Lightning dependency chain

`uni2ts.model.moirai2`'s package `__init__.py` unconditionally does
`from .forecast import Moirai2Forecast`, and `forecast.py` (the GluonTS-facing training/predict
wrapper — the thing that implements the **recursive multi-quantile decode loop** we're
explicitly told to skip) imports `lightning` and `gluonts`, neither of which is installed in
the shared venv, and both of which the venv's pinned `torch==2.13.0` would conflict with anyway
(`uni2ts`'s own `pyproject.toml` pins `torch>=2.1,<2.5`).

Rather than installing that whole chain (and forcing a torch downgrade shared with the sibling
spikes), `module.py` — the actual `Moirai2Module` we need — was loaded as a standalone module
via `importlib.util.spec_from_file_location`, bypassing the package `__init__.py` entirely
(`load_moirai2.py`). `module.py`'s own imports (`uni2ts.common.torch_util`, `uni2ts.module.*`)
were read line-by-line first to confirm they need nothing beyond `torch`, `einops`,
`jaxtyping`, `numpy`, `huggingface_hub`, `safetensors` — all already present or trivially
added. This sidesteps gluonts/lightning cleanly and is also, incidentally, exactly the shape of
the eventual Rust integration: we only ever need `Moirai2Module.forward(..., training_mode=False)`,
never the GluonTS wrapper.

## 3. Architecture read — what turned out to need a patch, and what didn't

Read `module.py`, `common/torch_util.py`, `module/attention.py`, `module/transformer.py`,
`module/position/{attn_projection,attn_bias}.py`, `module/packed_scaler.py`, and
`module/ts_embed.py` directly (not the paper, not secondary sources) to settle the risks the
dossier flagged as unverified.

### 3a. The anticipated Kronos-style `is_causal`+`attn_mask` conflict: **did not occur, confirmed by source**

`GroupedQueryAttention.forward` (`module/attention.py`) calls
`F.scaled_dot_product_attention(query, key, value, attn_mask=attn_mask, dropout_p=..., scale=...)`
— **`is_causal` is never passed** (defaults to `False`). Moirai2's own causal masking is baked
entirely into an explicit float/bool `attn_mask` tensor built by `_update_attn_mask`, which
combines `packed_causal_attention_mask(sample_id, time_id)` (the causal comparison) with the
per-variate `BinaryAttentionBias` additive term. Since the reference implementation never
combines `is_causal=True` with an explicit mask, the specific legacy-exporter assertion that hit
Kronos (`is_causal and attn_mask cannot be set at the same time`) simply never has a chance to
fire here. **No Kronos-style attention patch was needed.** This is worth stating plainly because
the dossier flagged it as the sharpest unresolved risk going in — reading the source resolved it
in our favor.

### 3b. Patch #1 (required): `.mT` has no opset-18 legacy-exporter symbol

First export attempt failed immediately with:
```
torch.onnx.errors.UnsupportedOperatorError: Exporting the operator 'aten::mT' to ONNX opset
version 18 is not supported
```
Root cause: `packed_attention_mask` (`uni2ts/common/torch_util.py:41`) does
`sample_id.eq(sample_id.mT)` — PyTorch's `.mT` transpose-accessor shorthand has no legacy
TorchScript ONNX symbolic registered at opset 18 (`.transpose(-2, -1)`, its exact equivalent,
does). **Patch:** rewrite to `sample_id.eq(sample_id.transpose(-2, -1))`. Verified
behaviorally neutral: eager output bit-identical before/after (`np.array_equal(...) == True`,
max abs diff `0.0`).

### 3c. Patch #2 (required — the real "same conflict recurs, different op" case): masked-assignment shape bug

With patch #1 alone, `torch.onnx.export` succeeded (no error, no warning about this), but the
resulting graph **failed to even load** in onnxruntime:
```
onnxruntime.capi.onnxruntime_pybind11_state.Fail: [ONNXRuntimeError] : 1 : FAIL : Load model
from moirai2_small.onnx failed:Node (/module/Sub) Op (Sub) [ShapeInferenceError]
Incompatible dimensions
```
Root cause: `PackedStdScaler._get_loc_scale` (`module/packed_scaler.py:120-121`) ends with:
```python
loc[sample_id == 0] = 0
scale[sample_id == 0] = 1
```
`sample_id` is shape `*batch seq_len` (no trailing dim) while `loc`/`scale` are
`*batch seq_len 1`. Eager PyTorch's boolean **advanced-indexing** `__setitem__` correctly
aligns the mask against `loc`'s *leading* dims and broadcasts the trailing 1. But
`torch.onnx`'s legacy tracer lowers this assignment to an elementwise `Where` node whose
condition keeps `sample_id`'s literal 2-D shape — and ONNX's (and onnxruntime's) `Where`
broadcasting aligns shapes from the *right*: `[*, seq_len]` vs. `[*, seq_len, 1]` broadcasts to
`[*, seq_len, seq_len]`, not the intended `[*, seq_len, 1]`. The trace itself "succeeds" (no
export-time error) because the exporter doesn't shape-check its own output; the defect only
surfaces when a spec-compliant runtime (onnxruntime) tries to load the graph.

This is exactly the category of problem the brief anticipated recurring from the Kronos
playbook (a trace-time operator-lowering mismatch that produces a graph which *exports* cleanly
but is wrong/broken), just manifesting in a different specific op (masked scaler assignment,
not SDPA `is_causal`). **Patch:** replace the two masked assignments with an explicit
`torch.where` against a manually-unsqueezed mask:
```python
pad_mask = (sample_id == 0).unsqueeze(-1)
loc = torch.where(pad_mask, torch.zeros_like(loc), loc)
scale = torch.where(pad_mask, torch.ones_like(scale), scale)
```
Verified behaviorally neutral the same way as patch #1 (bit-identical eager output,
`max abs diff 0.0`) before re-attempting the export. Both patches are **export-only, local to
this spike's cloned `uni2ts` copy** (`scratchpad/spike-moirai/uni2ts/src/uni2ts/{common/torch_util.py,module/packed_scaler.py}`)
— nothing is vendored into this repo, matching the Kronos precedent's pattern.

### 3d. `variate_id`/`sample_id`/`time_id`/`prediction_mask` packing tensors: confirmed to collapse to constants

As the dossier speculated and the brief asked to confirm: for a single, unpacked, univariate
window with no `feat_dynamic_real`, all four packing tensors are **input-independent
constants**, not something that needs to be computed at runtime from real data:
- `sample_id = 1` everywhere (uni2ts convention: `sample_id == 0` means "padding", and
  `PackedStdScaler` special-cases it to `loc=0, scale=1`; a real single series must be
  non-zero, so `1` is correct and constant).
- `variate_id = 0` everywhere (the one channel).
- `time_id = arange(num_patches)` (0..31 for a 512/16 = 32-patch context).
- `prediction_mask = False` everywhere — see §3e for why there's no "future" position at all
  in this design.

These are registered as `nn.Module` **buffers** on the export wrapper (not graph inputs), so
`torch.onnx.export` bakes them in as graph initializers/constants — the exported ONNX graph's
*only* public input is the raw closes window (§4).

### 3e. Design simplification: dropped the "future placeholder" sequence positions entirely

`uni2ts`'s own GluonTS-facing `Moirai2Forecast.forward()` builds a `combine_seq = context +
future` sequence (context patches + zero-filled future placeholder patches), runs the whole
thing through `Moirai2Module`, then reads the forecast off `pred_index = context_token_length
- 1` (the *last context* position). But `packed_causal_attention_mask` only lets a query
attend to keys with `time_id <= query's time_id` — so the last context position's output can
**never** depend on the future placeholder positions (they all have larger `time_id`), no
matter what values they hold. Since Moirai 2.0's "multi-token prediction" already means one
position's output head directly regresses all `num_predict_token` future patches (not
autoregressively, one token at a time), the future placeholder positions are provably dead
weight for a single, non-recursive forward pass. This spike's export wrapper therefore feeds
**only the 32 real context patches** (no future placeholders at all) and reads the forecast off
the literal last position (index 31) — simpler, smaller graph, identical result (confirmed:
this *is* what was validated against eager PyTorch below, not a hypothesis).

## 4. Export result

**Input/output contract** (`scratchpad/spike-moirai/moirai2_wrapper.py` — `Moirai2OnnxWrapper`):

| | Name | Shape | Dtype | Meaning |
|---|---|---|---|---|
| Input | `closes` | `[1, 512]` | f32 | Raw (unnormalized) close prices, most-recent last. |
| Output | `quantile_forecast` | `[1, 4, 9, 16]` | f32 | `[num_predict_token, num_quantiles, patch_size]` — see §6. |

`torch.onnx.export(wrapper, (closes_t,), ..., opset_version=18, dynamo=False)` — **no
`dynamic_axes`**, matching the Kronos playbook exactly.

- **File:** `scratchpad/spike-moirai/moirai2_small.onnx`, **46,042,963 bytes (43.9 MB)**,
  opset 18, `ir_version 8`. Comfortably inside the dossier's 45–90 MB estimate — actually a bit
  smaller, since this export carries none of the GluonTS wrapper's recursive-decode machinery.
- **(a) `onnx.checker.check_model`: PASS.**
- **(b) op inventory:** 1,004 nodes, 29 distinct op types, **0 `Loop`, 0 `If`**. Full histogram:
  `Add:65, And:3, Cast:20, Concat:25, Constant:311, ConstantOfShape:12, Div:28, Equal:14,
  Expand:12, Gather:3, Identity:2, LessOrEqual:1, MatMul:60, Mul:118, Neg:12, Not:1, Pow:26,
  ReduceMean:25, ReduceSum:6, Reshape:57, Sigmoid:8, Softmax:6, Split:24, Sqrt:26, Squeeze:24,
  Sub:3, Transpose:54, Unsqueeze:36, Where:22`.
- **(c) quantile head + final reshape:** the `out_proj` `ResidualBlock` (Linear→SiLU→Linear +
  residual Linear) exports as plain `MatMul`/`Add`/`Sigmoid`/`Mul` ops (SiLU = `x * sigmoid(x)`);
  the final `[1,4,9,16]` reshape is a static `Reshape` against a `Constant` shape tensor
  `[1,4,9,16]`. Graph output shape is fully static (no symbolic dims). **PASS.**
- **(d) cross-validation vs. PyTorch eager** (onnxruntime, CPUExecutionProvider):
  - Fixture window (first 512 closes of the Kronos regression fixture, see §7): **max abs err
    9.537e-07, max rel err 8.844e-08.**
  - Independent second window (last 512 closes of the same source file — different value
    regime, 9.61–10.68 vs. the fixture's ~10.85–11.28, to confirm the two patches generalize
    and this isn't a lucky one-window result): **max abs err 9.537e-07, max rel err
    9.761e-08.**
  - Both are **~4 orders of magnitude inside** the brief's `1e-3` bar, and the residual is
    consistent with ordinary float32 kernel-ordering noise between PyTorch's and onnxruntime's
    CPU matmul/softmax, the same character of noise the Kronos spike saw (2.7e-5) — not a
    correctness gap.
  - Quantile monotonicity (`q0.1 <= q0.2 <= ... <= q0.9` at every one of the 64 raw future
    steps) holds with **zero violations** in both windows, for both the eager and ONNX outputs.

## 5. Numeric identity of the traced RoPE memoization (checked, not just assumed)

`RotaryProjection._init_freq` (`module/position/attn_projection.py`) conditionally
`register_buffer`s a larger `cos`/`sin` cache if `seq_id.max() + 1 > current cache size` — this
is the same category of thing that caused Kronos's dynamic-shape drift bug. Here, the cache is
constructed at model-init time with `max_len=512` (from `max_seq_len`), and our context is only
32 patches (`time_id` 0..31), so `32 < 512` and the growth branch is always skipped for this
export — confirmed by inspection, not just inference: the exported graph contains no buffer
mutation, and the cross-validation numbers above already prove the baked-in `cos`/`sin` slice
matches eager exactly. This only matters for a fixed single-shape export (which is all this
task asked for); it would need re-examining if a future task tried multiple context lengths in
one graph (out of scope here, same as Kronos's `dynamic_axes` conclusion).

## 6. Normalization + quantile output layout (for Rust replication)

### Normalization — `PackedStdScaler`, confirmed empirically against the model's own internals

**Correction to the dossier:** the dossier's source read described the scaler as computed
"causally from the first 30% of context." Direct inspection of `PackedStdScaler._get_loc_scale`
plus an instrumented forward pass (hooking `model.scaler.forward` and diffing against a manual
NumPy computation) shows this is **not** what the shipped code does — it's a plain **global
instance/window normalization over the entire observed context**, no 30%-subset windowing:

```
loc   = mean(closes)                              # over all 512 raw values in the context
scale = sqrt(unbiased_var(closes, ddof=1) + 1e-5)  # ddof=1 matches the scaler's `correction=1`
scaled = (closes - loc) / scale
```

Measured on the fixture window: `loc = 10.936503926292062`, `scale = 0.16664501456624575`,
matching the model's internal computation to `4.4e-7` / `5.7e-9` (float32-vs-float64 rounding
only — the scaler casts to `double` internally then back to `float`). This is the exact formula
to replicate in Rust: compute mean and sample-variance (Bessel-corrected, `ddof=1`) over the
raw 512-close window, `scale = sqrt(var + 1e-5)`. (The "first 30%" mechanism the paper describes
may be a training-time data-filtering detail, not this inference-time scaler — out of scope to
resolve further here since it doesn't affect what Rust needs to replicate.)

The de-normalization (`preds * scale + loc`) is already baked into the traced graph (the
`training_mode=False` branch of `Moirai2Module.forward`) — Rust does **not** need to re-apply
it; the ONNX graph's output is already in raw-price units, not scaled/normalized units.

### Quantile output layout

Output tensor `[1, num_predict_token=4, num_quantiles=9, patch_size=16]`:
- **`num_predict_token` (axis 1, size 4):** which of the 4 direct-regression future patches.
- **`num_quantiles` (axis 2, size 9):** quantile levels `[0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7,
  0.8, 0.9]` in that fixed order — index 4 is the median (q0.5).
- **`patch_size` (axis 3, size 16):** offset within the patch.
- **Raw future step index** (0..63, i.e. up to 64 raw bars ahead in one forward pass, matching
  `num_predict_token(4) × patch_size(16)`): `raw_step = predict_token_idx * 16 + patch_offset`.

### Conviction (quantile-spread — Moirai's real edge over Kronos, per the dossier)

Computed on the fixture window's first future step (`raw_step=0`): `last_close = 10.93`,
`q10 = 10.9014`, `q50 = 10.9256`, `q90 = 10.9483`. Suggested mapping to `AlgoOutput` (mirrors
the dossier's §5 and the Kronos convention of an `"model opinion: ..."`-prefixed evidence
string, never a bare verdict):
- **direction** = `sign(q50 - last_close)` → `down` on this fixture (tiny move: `-0.041%`).
- **magnitude** = `|q50 - last_close| / last_close` → `0.000406` (0.041%).
- **conviction** ≈ `1 - clamp((q90 - q10) / |q50|, 0, 1)` → `0.9957` on this fixture (a very
  tight quantile band relative to price level, i.e. high model confidence in a near-flat
  short-term move) — an actual predictive-distribution-derived confidence, not Kronos's
  softmax-probability stand-in.

## 7. Reference fixture

- `scratchpad/spike-moirai/moirai_context.csv` — 512 raw close prices, the input window.
  Sourced from the **first 512 rows** of the Kronos integration's own committed regression
  fixture (`__references/Kronos/tests/data/regression_input.csv` — real 5-minute A-share OHLCV,
  already vetted and used for the Kronos spike/integration), for cross-model consistency and
  because it's real market data already in this repo's reference tree rather than a synthetic
  series invented for this spike alone.
- `scratchpad/spike-moirai/moirai_expected_quantiles.csv` — the reference forecast, long-form
  (`predict_token, quantile_level, patch_offset, raw_step, value`), 576 rows
  (4 × 9 × 16), generated from the **patched** PyTorch-eager wrapper (§3b/§3c), i.e. this is the
  ground truth the ONNX graph was validated against, not upstream's own numbers (no upstream
  regression fixture exists for Moirai — this is a first-of-its-kind fixture).
- `scratchpad/spike-moirai/reference_output.npy` / `context_closes.npy` — the same data as
  `.npy`, used directly by `validate_onnx.py`.
- `scratchpad/spike-moirai/moirai2_small.onnx` — the exported graph itself.

## 8. Scripts (all in `scratchpad/spike-moirai/`, not committed)

- `load_moirai2.py` — standalone `Moirai2Module` loader (bypasses the GluonTS/Lightning import
  chain, §2).
- `moirai2_wrapper.py` — `Moirai2OnnxWrapper`, the fixed-shape `nn.Module` actually traced.
- `build_reference.py` — loads the model, runs the eager reference forward, dumps fixtures.
- `export_onnx.py` — the `torch.onnx.export(..., opset_version=18, dynamo=False)` call.
- `validate_onnx.py` — `onnx.checker`, Loop/If op-inventory scan, static-shape check, and the
  onnxruntime-vs-eager cross-validation (the four GO-criteria checks in §4, run in that order).
- Patches (local to the cloned `uni2ts` copy, not vendored into this repo):
  `uni2ts/src/uni2ts/common/torch_util.py` (`packed_attention_mask`, §3b),
  `uni2ts/src/uni2ts/module/packed_scaler.py` (`PackedStdScaler._get_loc_scale`, §3c).

## 9. What this spike deliberately did not cover

- **Rust `ort` load/run** — out of scope for this task by explicit instruction (Python-only
  feasibility spike; no cargo/Rust builds). onnxruntime (Python) cross-validation stands in for
  it here, same role it played in the Kronos spike before the Rust integration task.
- **The recursive multi-quantile decode loop** (`Moirai2Forecast.forward()`'s `while remain_step
  > 0` branch, for horizons beyond `num_predict_token × patch_size = 64` raw steps) — explicitly
  out of scope per the brief; this product's use case is near-horizon, and §3e shows the
  single-pass path is not just "good enough" but architecturally sufficient (multi-token
  prediction, not autoregression) for anything up to 64 raw steps ahead.
- **Missing-data / padding support** (`observed_mask` with real zeros, `sample_id` padding
  branch) — the exported graph is correct for the always-nonzero, always-observed inputs this
  product's `MarketContext` provides (frontier-sliced, no-lookahead OHLCV with no gaps); the
  `torch.where`-based padding patch (§3c) is verified not to change behavior when the padding
  condition is never true, but a real "missing bar" scenario was not separately exercised.
- **base/large Moirai-2.0 checkpoints** — only `-R-small` (11.4M, the brief's target) was
  tested; same module classes, so the two patches are expected to transfer, not independently
  confirmed.
