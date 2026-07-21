# Chronos-Bolt-small → ONNX → `ort` feasibility spike (Task 2)

**Date:** 2026-07-20
**Status:** exploratory spike, complete within timebox. No product code changed, no git commits
(this repo is not a git repo in the spike environment; nothing was staged/committed regardless).

## Verdict: **GO**

`amazon/chronos-bolt-small` (47.72M params, confirmed exact HF id, confirmed exact param
count) exports to a **single fixed-shape ONNX graph** (`opset_version=18`, `dynamo=False`, no
`dynamic_axes`) that loads cleanly in `onnxruntime`, passes `onnx.checker.check_model(...,
full_check=True)`, contains **zero `Loop`/`If` nodes**, and numerically matches the PyTorch
eager reference to **max relative error 2.24e-7** on a full-history fixture and **1.17e-7** on a
second, NaN-left-padded ("insufficient history") fixture — both **more than three orders of
magnitude inside the brief's `1e-3` bar**.

**Three small export-only patches were needed, not one.** The dossier correctly flagged
`aten::nanmean` as unsupported and it was the first thing hit; cross-validation immediately
surfaced two more implementation-level export bugs (a `torch.full` dtype-inference issue, and a
`.unfold()`-to-ONNX axis-swap bug) that the dossier's research had no way to know about since no
one has previously published a fixed-shape, opset-18 export of this model. All three are
export-only, ~10 lines apiece, and are documented below with root cause and fix.

**Favorable finding, contrary to the brief's assumption:** because the *entire* `model.forward()`
call (patch → encode → decode → de-normalize) is exported as one graph, **Chronos's RevIN-style
instance normalization does NOT need to be reimplemented in Rust.** Rust feeds raw closes in and
reads already-de-normalized, real-price-scale quantiles out. The formula is documented below for
debugging/sanity-check purposes only, mirroring how the Kronos spike found the BSQ tokenizer
didn't need a Rust reimplementation either.

---

## 1. Checkpoint and environment

- **Exact HF id:** `amazon/chronos-bolt-small` (confirmed live via `https://huggingface.co/api/models/amazon/chronos-bolt-small` and `.../resolve/main/config.json` — NOT `chronos-bolt-base`).
- **Exact param count:** **47,718,016** (47.72M) — read directly by summing `model.parameters().numel()` after `from_pretrained`, matching the dossier's "~48M small" sizing exactly.
- **Checkpoint size on disk:** `model.safetensors` = 190,888,824 bytes (~182.05 MiB, fp32), downloaded via `huggingface_hub.snapshot_download`.
- **Config (from live `config.json`, differs from the dossier's `-base` numbers):**
  ```
  d_model: 512, d_ff: 2048, num_layers: 6 (encoder), num_decoder_layers: 6, num_heads: 8, d_kv: 64,
  context_length: 2048, input_patch_size: 16, input_patch_stride: 16, prediction_length: 64,
  quantiles: [0.1, 0.2, ..., 0.9] (9 levels), use_reg_token: true
  ```
  (`-base` is 768/3072/12/12 per the dossier — `-small` is the same architecture family, roughly a quarter the encoder/decoder width, ~4x fewer params.)
- **Environment:** reused venv `scratchpad/kronos-venv` (Python 3.12.13, already had `torch==2.13.0`, `onnx==1.22.0`, `onnxruntime==1.27.0`). Added `chronos-forecasting==2.3.1` (pulls `transformers==5.14.1`, `accelerate==1.14.0`, `huggingface_hub==1.24.0`) via plain `pip install chronos-forecasting`.
- **License:** Apache-2.0 (confirmed via HF Hub API tag `license:apache-2.0`), same as documented in the dossier.
- Work directory: `scratchpad/spike-chronos/` (HF cache under `scratchpad/spike-chronos/hf-cache/`, kept local to the spike, not `~/.cache`).

## 2. The three export-only patches

All three live in a **local, standalone copy** of the installed `chronos/chronos_bolt.py`
(`scratchpad/spike-chronos/chronos_bolt_patched.py`, loaded via `importlib` at export time,
never vendored into the product repo — export tooling only, exactly like the Kronos spike's
`module.py` patch).

### 2.1 `aten::nanmean` (the one the dossier predicted)

Reproduced live, first, before trusting the dossier's claim (`scratchpad/spike-chronos/check_naive_export_fails.py`):
```
UnsupportedOperatorError: Exporting the operator 'aten::nanmean' to ONNX opset version 18 is not supported
```
Fix — hand-rolled isnan/where/sum/clamp replacement, same idea as `canerturkmen`'s PoC cited in
the dossier, applied at both call sites in `InstanceNorm.forward`:
```python
def nanmean_export_safe(tensor: torch.Tensor, dim: int, keepdim: bool = False) -> torch.Tensor:
    mask = ~torch.isnan(tensor)
    zeroed = torch.where(mask, tensor, torch.zeros_like(tensor))
    count = mask.sum(dim=dim, keepdim=keepdim).clamp(min=1)
    return zeroed.sum(dim=dim, keepdim=keepdim) / count
```

### 2.2 `torch.full` dtype inference under trace (new — not in the dossier)

After patch 2.1, export succeeded but `onnx.checker`/`onnxruntime` both rejected the graph:
```
Type Error: Type 'tensor(float)' of input parameter (/model/Constant_8_output_0) of operator
(Gather) in node (/model/shared/Gather) is invalid.
```
Root cause: `reg_input_ids = torch.full((batch_size, 1), self.config.reg_token_id, device=...)`
and the analogous `decoder_input_ids` construction infer `int64` correctly in eager mode
(confirmed: `torch.full((1,1), 1).dtype == torch.int64`), but the legacy TorchScript tracer
folded the constant as `float32` in the traced graph, feeding a float tensor into the token
embedding's `Gather`. Fix: pass `dtype=torch.long` explicitly at both call sites (`encode()`'s
`reg_input_ids` and `decode()`'s `decoder_input_ids`) — a behavior-neutral, export-only pin of a
dtype that was always semantically `int64` anyway.

### 2.3 `.unfold()` axis-swap under trace (new — not in the dossier)

After patch 2.2, export succeeded but `onnx.checker`/`onnxruntime` both rejected the graph again,
this time deeper in the network:
```
[ShapeInferenceError] (op_type:MatMul, node name: /model/input_patch_embedding/residual_layer/MatMul):
Incompatible dimensions for matrix multiplication
```
Root cause (traced through the graph node-by-node, `scratchpad/spike-chronos/` ad-hoc dump
scripts): `Patch.forward`'s `x.unfold(dimension=-1, size=16, step=16)` decomposes, under the
legacy tracer, into 128 `Slice`+`Unsqueeze` nodes concatenated with `Unsqueeze` axis `-1` — i.e.
it builds shape `(batch, patch_size, num_patches)` = `(1, 16, 128)` instead of the correct
`(batch, num_patches, patch_size)` = `(1, 128, 16)`. This is an axis-order bug in how the legacy
tracer expands `.unfold()`, not anything specific to Chronos.

Fix: both `chronos-bolt-small` and `-base` configs set `input_patch_stride == input_patch_size`
(non-overlapping patches) — for that specific case, `.unfold()` is exactly equivalent to
`.reshape()`:
```python
>>> x = torch.arange(3*2048).reshape(3, 2048).float()
>>> torch.equal(x.unfold(-1, 16, 16), x.reshape(3, 2048 // 16, 16))
True
```
So `Patch.forward` now branches: if `patch_stride == patch_size`, use `.reshape(*x.shape[:-1],
x.shape[-1] // patch_size, patch_size)` instead of `.unfold(...)`. This traces to a single
`Reshape` node and is bit-identical to eager `.unfold()` for this model family. The general
`.unfold()` path is left in place (unreachable for this model, but preserves correctness if a
future checkpoint ever set `stride != size`).

**All three patches were validated end-to-end** (not just "export succeeds") — see §4.

## 3. Export: fixed shape, opset 18, `dynamo=False`, no `dynamic_axes`

Wrapper (`scratchpad/spike-chronos/export_chronos_onnx.py`):
```python
class ChronosBoltONNXWrapper(nn.Module):
    def __init__(self, model):
        super().__init__()
        self.model = model

    def forward(self, context: torch.Tensor) -> torch.Tensor:
        return self.model(context=context).quantile_preds
```
`mask`, `target`, `target_mask` are left at their `None` defaults — `mask=None` makes the graph
derive the mask from `isnan(context)` internally (plain elementwise ops, not a branch); `target=
None`/`target_mask=None` are Python-level `None` checks resolved at trace time (no ONNX `If`
node), so the loss-computation branch never enters the graph at all. This is why the graph has a
single tensor input, not four.

```python
torch.onnx.export(
    wrapper, (context_tensor,), "chronos_bolt_small_fixed.onnx",
    input_names=["context"], output_names=["quantile_preds"],
    opset_version=18, dynamo=False, do_constant_folding=True,
)
```
`context_tensor` is `torch.float32` shape `(1, 2048)` — **exactly** `context_length`, so the two
data-dependent `if` branches (`context.shape[-1] > context_length` in `encode()`;
`length % patch_size != 0` in `Patch.forward`, now mostly moot after §2.3) both evaluate to a
single static path and vanish from the traced graph, per the dossier's prediction.

**Graph facts (measured, not assumed):**
- `ir_version: 8`, opset `(domain='', version=18)`, **1,162 nodes**.
- Input: `context` — `float32[1, 2048]`.
- Output: `quantile_preds` — `float32[1, 9, 64]`.
- 38 distinct op types present, **`Loop`/`If`: absent** (confirmed by iterating `graph.node` op
  types — full list is in `scratchpad/spike-chronos/chronos_fixture_meta.json`).
- `onnx.checker.check_model(m, full_check=True)`: **PASS**.
- File size: **191,527,300 bytes (191.53 MB / ~182.65 MiB)** fp32 — essentially the checkpoint
  size (182.05 MiB) plus small graph/initializer overhead, as expected.

## 4. Cross-validation vs PyTorch eager — **GO bar met on both scenarios tested**

| Scenario | max abs err | max rel err | Notes |
|---|---|---|---|
| Full 2048-bar real-valued context (synthetic seeded random walk, no NaNs) | 9.77e-4 | **2.24e-7** | float32 kernel-ordering noise between PyTorch's and ORT's CPU matmul/softmax — not a correctness problem |
| Only 500 real bars, leading 1,548 positions NaN-padded (the model's own "insufficient history" handling — exercises the nanmean patch on real NaNs, not just NaN-free data) | 4.88e-4 | **1.17e-7** | confirms patch 2.1 didn't just make export *succeed*, it produces the *same* answer as eager on the exact input shape it exists for |

Both several orders of magnitude inside the brief's `max relative error < 1e-3` bar. Neither run
produced any NaN in the ONNX output (explicitly asserted in
`scratchpad/spike-chronos/validate_nan_padded_context.py`).

Reproduction: `scratchpad/spike-chronos/export_chronos_onnx.py` (main scenario, also does the
export + writes fixtures) and `scratchpad/spike-chronos/validate_nan_padded_context.py` (second
scenario, reuses the already-exported `.onnx` file).

## 5. Normalization — baked into the graph, **not** required in Rust

`InstanceNorm` (RevIN-style) computes, per the live source (`chronos/chronos_bolt.py`):
```
loc   = nan_to_num(nanmean(context, dim=-1, keepdim=True), nan=0.0)
scale = nan_to_num(sqrt(nanmean((context - loc)^2, dim=-1, keepdim=True)), nan=1.0)
scale = where(scale == 0, eps=1e-5, scale)
scaled = (context - loc) / scale
```
`chronos-bolt-small`'s `InstanceNorm()` is constructed with `use_arcsinh=False` (the class
default, not exposed via `chronos_config` for this model) — **no `arcsinh` transform is applied**
for this checkpoint, so there is nothing to invert on that front either.

At the *output* end, `instance_norm.inverse(quantile_preds, loc_scale)` (`x * scale + loc`) is
applied **inside the same exported graph**, before the tensor reaches the `quantile_preds`
output. **This means Rust does not need to compute `loc`/`scale` or de-normalize anything** — the
ONNX graph's single output is already in real closing-price units. This is a deviation from the
brief's step 4 expectation ("must be replicated in Rust") in the favorable direction: because the
whole `forward()` was exported as one graph (encode → decode → de-normalize), rather than only
the encoder/tokenizer sub-modules as Kronos's spike did, the normalization math never needs a
second, independent Rust implementation. The formula above is recorded for debugging/sanity-check
purposes only (e.g. if a future task wants to reproduce `loc`/`scale` in Rust for logging or a
volatility-normalized conviction score — see §7).

## 6. Input/output tensor shapes — exact contract for Rust

- **Input:** `context`, `float32`, shape `[1, 2048]`. Raw `close` prices (univariate, no
  log-returns, no scaling) — most recent 2048 bars, most recent last. If fewer than 2048 real
  bars are available, **left-pad with `NaN`** (not zero, not the earliest real value) to reach
  exactly 2048 — this is the model's own designed "insufficient history" handling and was
  numerically validated in §4. Batch dimension is fixed at 1 (single-instrument, single-window
  calls — matches how Kronos is called in this codebase).
- **Output:** `quantile_preds`, `float32`, shape `[1, 9, 64]`, **already de-normalized to real
  price units**.
  - **Axis 1 (size 9): quantile levels, in ascending order** `[0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7,
    0.8, 0.9]` — index 0 = q10, index 4 = **q50 (median)**, index 8 = q90. This order comes
    directly from `config.json`'s `chronos_config.quantiles` list and is not reordered anywhere
    in `forward()`.
  - **Axis 2 (size 64): forecast horizon steps**, index 0 = **next bar** (1 step past the last
    context close), index 63 = 64 steps ahead. `prediction_length=64` is baked into the exported
    graph at trace time (confirmed: the `ResidualBlock` output head's `out_dim = num_quantiles *
    prediction_length` is a fixed weight-matrix dimension, not a runtime shape) — **changing the
    horizon requires re-exporting**, not a runtime parameter. This matches the dossier's
    "unresolved in the upstream community thread" flag; it remains unresolved here too (out of
    scope for a from-scratch fixed-shape export, not attempted).
  - **Our near-horizon (1/5) use:** read index 0 for a next-bar signal, or indices 0–4 for a
    5-bar-ahead horizon — both are trivial slices of the same single forward-pass output; no
    rolling/re-invocation loop is needed since 5 « 64.

## 7. Conviction from quantile spread — layout confirmed, formula illustrated (not finalized)

Direction and magnitude, mirroring the existing Kronos convention:
```
direction = sign(q50[step_k] - last_close)      # Bullish / Bearish / Neutral (epsilon dead-band)
magnitude = |q50[step_k] - last_close| / last_close
```
Conviction, from quantile spread (dossier's suggested shape, illustrated numerically on the
fixture — `q10[step]`/`q90[step]` axis-1 indices 0 and 8, `recent_vol` = std of context
log-returns over the trailing 64 bars):
```
rel_spread  = (q90[step_k] - q10[step_k]) / q50[step_k]
horizon_vol = recent_vol * sqrt(step_k + 1)
conviction  = clamp(1 - rel_spread / (K * horizon_vol), 0, 1)   # K is a tunable scale, illustrated with K=4
```
On the fixture (`last_close = 4745.53`): `step0`: q10=4625.96, q50=4781.73, q90=4920.11 →
direction=Bullish, magnitude=0.76%, rel_spread=6.15%, conviction≈0.00 (a fairly wide band against
a calm recent regime); `step4`: rel_spread=9.75%, conviction≈0.18. **The exact scaling constant
`K` and volatility window are a tuning question for the algorithm-integration task, not something
this feasibility spike claims to have nailed down** — what's confirmed here is only the *shape*
(`q10`/`q50`/`q90` are directly indexable at axis 1 positions 0/4/8, per §6) and that the model's
own quantile head gives a genuine, principled uncertainty signal (band visibly widens with
horizon: 294 price-units wide at step0 vs. 465 at step4).

## 8. Resource footprint

- **ONNX file:** 191,527,300 bytes (~191.5 MB / ~182.65 MiB) fp32, single file, no external
  weight files.
- **RAM, combined Python export/validation process** (torch + onnxruntime both loaded
  simultaneously, worst case for this spike's own tooling, **not** representative of the Rust
  runtime): peak RSS **1,758.6 MB**.
- **RAM, onnxruntime-only process** (`scratchpad/spike-chronos/measure_onnxruntime_only_rss.py`
  — closer proxy for the eventual Rust `ort` footprint, since the shipped app never loads
  PyTorch): peak RSS **354.0 MB** (40.9 MB baseline → 342.6 MB after `InferenceSession` load →
  354.0 MB after 3 inference calls). This is well inside the dossier's "1–1.5 GB" estimate (which
  was for the 4x-larger `-base` model) and comfortably fits an 8–16 GB laptop with headroom.
- **Latency:** not benchmarked precisely in this timebox (out of scope per the brief — same
  caveat the dossier already flagged: no sourced absolute-latency number exists). Qualitatively,
  each export/inference call in this spike (model load + forward pass over 2048→128 patch tokens
  through a 6-layer T5 encoder/decoder) completed in well under a second on this machine's CPU.

## 9. GO/NO-GO criteria — checklist

| Criterion | Result |
|---|---|
| Fixed-shape export (opset 18, `dynamo=False`, no `dynamic_axes`) | **met** |
| `onnx.checker.check_model` passes | **met** (after patches 2.1–2.3) |
| No dynamic `Loop`/`If` in the graph | **met** (0 of 1,162 nodes) |
| Max relative error vs PyTorch eager < 1e-3 | **met** — 2.24e-7 (normal), 1.17e-7 (NaN-padded) |
| `nanmean` op-swap applies and produces matching results | **met** — verified on both fixtures, not just "export succeeds" |
| Exact input/output shapes documented | **met** — `[1,2048]` → `[1,9,64]`, §6 |
| Normalization documented | **met** — and found to require **no Rust reimplementation**, §5 |
| Reference fixture for Rust unit test | **met** — §10 |
| Quantile output layout confirmed | **met** — ascending `[0.1..0.9]` × 64-step horizon, §6 |

## 10. Artifacts (all under `scratchpad/spike-chronos/`, not committed anywhere)

- `chronos_bolt_patched.py` — local, export-only patched copy of `chronos_bolt.py` (3 patches:
  §2.1–2.3), loaded dynamically at export time, never vendored into the product repo.
- `check_naive_export_fails.py` — confirms the unpatched `aten::nanmean` failure reproduces
  before trusting the dossier's claim.
- `make_fixture.py` — generates the deterministic (seeded) synthetic raw-`close` context window,
  `chronos_context.csv` (2,048 rows, `step,close`).
- `export_chronos_onnx.py` — loads the patched model, exports the fixed-shape ONNX graph
  (`chronos_bolt_small_fixed.onnx`), cross-validates vs PyTorch eager, writes
  `chronos_expected_quantiles.csv` (9 rows × 64 columns, `quantile,step0,...,step63`) and
  `chronos_fixture_meta.json` (all the numeric facts quoted in this doc).
- `validate_nan_padded_context.py` — the second (NaN-padded, "insufficient history") validation
  scenario in §4.
- `measure_onnxruntime_only_rss.py` — isolated-process RAM measurement (§8).
- `chronos_bolt_small_fixed.onnx` — the exported fixed-shape graph (~191.5 MB).
- `chronos_context.csv` + `chronos_expected_quantiles.csv` — the reference fixture pair for a
  future Rust unit test: feed the 2,048 closes into the `ort`-loaded copy of the `.onnx` file,
  assert the 9×64 output matches this CSV within relative tolerance `< 1e-3` (the same bar this
  spike met against PyTorch eager, so `ort` in Rust is expected to reproduce it with the same
  margin the Kronos spike found for ONNX Runtime's CPU EP kernel-ordering noise).

## 11. Biggest integration risk

**`prediction_length=64` is permanently baked into the exported graph's weight shapes, and no
public precedent (community thread or otherwise) exists for re-exporting at a different
prediction length** — same open question the dossier flagged. It is a non-issue for this
product's stated near-horizon (1/5-bar) use (§6), since 5 ≪ 64 bars are simply read from the one
forward pass. It would only become a blocker if a future task wants a native horizon *longer*
than 64 bars without adopting the Python pipeline's own patch-level rolling-context re-invocation
loop (documented in the dossier, not attempted here as out of scope).

Secondary risk, already mitigated but worth flagging for whoever picks this up next: the two new
patches found in §2.2/§2.3 mean **this export recipe is not "the community PoC plus one line" as
the dossier anticipated — it required real from-scratch debugging** (tracing ONNX graph nodes
back through `Slice`/`Unsqueeze`/`Constant` chains to find a tracer-decomposition bug). Any future
re-export (e.g. targeting `chronos-bolt-base` per the dossier's noted upgrade path, or a newer
`transformers`/`torch` version) should re-run the full `onnx.checker` + `onnxruntime`-load +
cross-validation sequence in this spike rather than assuming a clean export on the first try.

## 12. What was NOT covered (honest gaps, given the timebox)

- No absolute latency benchmark (matches the dossier's own caveat — no sourced number exists
  anywhere for this model family; not attempted here either).
- No Rust/`ort` load-and-run was performed (explicitly out of scope per this task's brief: "pure
  Python feasibility... NO cargo/Rust builds"). The fixture files in §10 are prepared specifically
  so that step is a mechanical follow-up, not a new feasibility question — same posture the
  Kronos spike took toward its own Rust-side validation.
- `chronos-bolt-base` was not re-exported or re-validated — the dossier's noted upgrade path
  remains theoretical; the three patches in §2 are expected to transfer (same module classes,
  same `input_patch_stride == input_patch_size` config), but this was not empirically re-checked.
- The rolling-context loop for horizons beyond 64 bars (§11) was read and understood but not
  implemented or tested — out of scope for this product's near-horizon use case.
