## Granite-TTM r2 → ONNX → `ort` feasibility spike (Task 1)

**Date:** 2026-07-20
**Status:** exploratory spike, complete within timebox. No product code changed, no git commits.

## Verdict: **GO**

All three fixed-shape checkpoints (`512-96-r2`, `1024-96-r2`, `1536-96-r2`) export cleanly to
static-shape ONNX (opset 18, `dynamo=False`, no `dynamic_axes`) with **zero unsupported-operator
failures**, `onnx.checker.check_model(..., full_check=True)` passing on all three, and the exported
graphs — run through Python `onnxruntime` — numerically match the PyTorch eager reference to within
**max relative error 3.4e-7** (all three checkpoints), roughly **three thousand times** inside the
brief's `1e-3` GO bar. The FFT/topk code path (`TinyTimeMixerAddFFTPatches`) is confirmed inert **at
the module-construction level, not just by config flag inspection**: `fft_length` is absent from all
three real `config.json`s (defaults to `0`), so `TinyTimeMixerEncoder.__init__` never even
instantiates the FFT submodule — it structurally cannot appear in any traced graph regardless of
input values. Confirmed empirically: zero `Fft`/`Rfft`/`TopK`/`Loop`/`If`/`Scan` nodes in any of the
three exported graphs.

**One real, non-trivial bug was found and fixed during export** (not anticipated by the dossier):
the upstream `TinyTimeMixerAdaptivePatchingBlock.forward`'s reshape-shape arithmetic
(`hidden.shape[2] * self.adaptive_patch_factor`, computed from traced-shape proxies) bakes an
**incorrect literal shape** under PyTorch's legacy TorchScript ONNX tracer — verified directly in the
exported graph (`[1, 8, 4, 48]` instead of the correct `[1, 1, 32, 48]` for the 512-context
checkpoint's level-2 adaptive-patching block) — which makes `onnxruntime` (and would make Rust's
`ort`, same shape-inference code path) **refuse to even load the model**
(`[ShapeInferenceError] Incompatible dimensions for matrix multiplication`). This is a genuine
PyTorch/TorchScript exporter tracing defect, not a TTM architecture problem. Fixed with a small,
verified-neutral export-time patch (§4 below) — this is the one item a real integration must carry
forward, not a blocker to the GO verdict.

**Top reasons for GO:**
1. Single forward pass, no tokenizer, no autoregressive loop, no custom ops — objectively simpler to
   export than Kronos (confirmed, not just theorized): the whole export script is ~30 lines per
   checkpoint vs. Kronos's four-subgraph adapter set.
2. All three checkpoints are naturally fixed-shape (IBM ships them as separate checkpoints per
   `(context_length, prediction_length)` pair) — no `dynamic_axes` question to even consider, unlike
   Kronos's autoregressive loop.
3. Numeric parity is essentially exact (2.3e-7 to 3.4e-7 max rel error) — the residual is ordinary
   float32 CPU-kernel-ordering noise between PyTorch's and ONNX Runtime's matmul/layernorm
   implementations, not a correctness gap.
4. The FFT/topk risk the dossier flagged is resolved with a *stronger* guarantee than requested:
   not "the branch is gated off at runtime" but "the module is never constructed," which cannot
   regress silently the way a runtime `if` could.

**Main integration risk carried forward:** the adaptive-patching reshape export bug (§4) means the
export script cannot be a bare `torch.onnx.export(model, ...)` call — it requires the small vendored
patch below applied first. This is a known, solved, verified-neutral fix (analogous to Kronos's own
`is_causal`/`attn_mask` export-time patch), not an open research question.

---

## 1. Environment + checkpoints (Step 1)

- Reused the existing venv (`scratchpad/kronos-venv`, Python **3.12.13**) rather than a fresh one.
  Already had `torch==2.13.0` (CPU), `onnx==1.22.0`, `onnxruntime==1.27.0`.
- **Did not install `granite-tsfm` from PyPI.** Its `pyproject.toml` pins `torch>=2.10,<2.11` — doing
  so would have force-downgraded the shared venv's `torch` from 2.13.0 to 2.10.0, risking other
  in-flight work sharing that venv. Installed plain `transformers==5.14.1` instead (no `torch` pin;
  confirmed it does not touch the existing torch install) — the only two files actually needed,
  `modeling_tinytimemixer.py` and `configuration_tinytimemixer.py`, import only
  `transformers.modeling_utils` / `transformers.configuration_utils` / `transformers.time_series_utils`
  / `transformers.utils`, all present in 5.14.1, and have no other dependency on the rest of the
  `tsfm_public` package tree (its own `__init__.py` eagerly imports a `toolkit` module that would have
  pulled in heavier deps — sidestepped entirely by not going through the package `__init__`).
- Cloned `github.com/ibm-granite/granite-tsfm` (Apache-2.0) into `__references/granite-tsfm`
  (gitignored) to read the actual modeling code, exactly as the Kronos spike read
  `shiyu-coder/Kronos`'s source directly rather than trusting the model card alone.
- Copied (not pip-installed) `tsfm_public/models/tinytimemixer/{modeling,configuration}_tinytimemixer.py`
  verbatim into a small local package (`ttm_model/`) — same "read the real source, adapt minimally"
  approach as the Kronos precedent.
- Downloaded all three checkpoints via `huggingface_hub.hf_hub_download`, one per real git branch:

  | ctx | HF revision | `model.safetensors` | Confirms dossier? |
  |---|---|---|---|
  | 512 | `main` (= `512-96-r2`) | 3,240,592 B (3.24 MB) | yes |
  | 1024 | `1024-96-r2` | 11,879,480 B (11.9 MB) | yes |
  | 1536 | `1536-96-r2` | 12,344,144 B (12.3 MB) | yes |

- Loaded each with `TinyTimeMixerConfig.from_json_file(...)` + `TinyTimeMixerForPrediction(config)` +
  `load_state_dict(safetensors_dict, strict=False)`, then asserted `missing == [] and unexpected == []`
  — passed for all three, confirming the two vendored files are the exact architecture matching the
  released weights (not just "close enough").
- Config facts confirmed directly from the real downloaded `config.json`s (all three):
  `scaling: "std"`, `loss: "mse"`, `num_input_channels: 1`, `resolution_prefix_tuning: false`,
  `fft_length` **absent** (→ default `0`), `adaptive_patching_levels: 3`, `gated_attn: true`,
  `self_attn: false`, `mode`/`decoder_mode: "common_channel"`, `architectures: ["TinyTimeMixerForPrediction"]`.

  | ctx | `prediction_length` | `patch_length` | `num_patches` | `d_model` | `decoder_d_model` | measured `n_params` |
  |---|---|---|---|---|---|---|
  | 512 | 96 | 64 | 8 | 192 | 128 | 805,280 |
  | 1024 | 96 | 128 | 8 | 384 | 256 | 2,964,960 |
  | 1536 | 96 | 128 | 12 | 384 | 256 | 3,081,120 |

  (Measured param counts are somewhat below the paper's "~1M/~4M/~5M" — expected, since the
  instantiated `TinyTimeMixerForPrediction` for `loss: "mse"` never builds the vestigial
  `distribution_output`/`MultiQuantileHead` machinery the paper's larger figure may include; not a
  discrepancy that affects feasibility.)

## 2. Architecture read — forward pass, no loop (Step 1/2)

Read `modeling_tinytimemixer.py` directly rather than trusting the model card:

- `TinyTimeMixerForPrediction.forward(past_values, ...)` — **one call**, no `generate()`/sampling loop
  needed for the point forecast (the `generate()` method exists only for the unused
  `distribution_output` path, which is `None` for `loss: "mse"` and raises `Exception` if reached).
  All other forward args (`future_values`, `past_observed_mask`, `freq_token`,
  `static_categorical_values`) are optional and `None` in the inference path we need.
- Data flow: `past_values (B,T,1)` → `TinyTimeMixerStdScaler` (normalize) → `TinyTimeMixerPatchify`
  (`unfold`-based, compile-time `patch_length`/`patch_stride`) → `patcher` (`nn.Linear`) →
  `TinyTimeMixerEncoder` (patch-mixer + feature-mixer blocks, 3-level adaptive patching, all shapes
  config-fixed) → decoder mixer stack → prediction head → `scaler.inverse` (denormalize) →
  `prediction_outputs (B, 96, 1)`.
- No custom ops, no tokenizer, no KV-cache, no dynamic control flow reachable at inference — every
  `if`/`elif` in the forward path (context-length truncate/pad, mask truncate/pad) is a length
  comparison against a value that, for a genuinely fixed-shape trace, always takes the same branch;
  the exported graph freezes that branch, exactly as expected.

## 3. FFT/topk-path verification (Step 3, R3 risk) — resolved, stronger guarantee than requested

The brief asked to check whether `resolution_prefix_tuning: false` really gates the FFT/topk code off
(the dossier flagged `frequency_token_vocab_size` still being non-null as reason for doubt). Reading
the actual code shows the FFT path (`TinyTimeMixerAddFFTPatches`, using `torch.fft.rfft` +
`torch.topk`) is **not** gated by `resolution_prefix_tuning` at all — it's a **separate** flag:

```python
# TinyTimeMixerEncoder.__init__
self.add_fft_tokens = None
if config.fft_length > 0:
    self.add_fft_tokens = TinyTimeMixerAddFFTPatches(config)
```

`fft_length` defaults to `0` (`configuration_tinytimemixer.py`) and is **absent** from all three real
downloaded `config.json`s → default applies → `self.add_fft_tokens` is never constructed. Verified
directly: `model.backbone.encoder.add_fft_tokens is None` for all three loaded checkpoints. This is a
stronger check than "inspect the traced graph for stray nodes" (which was also done, and also came up
empty) — the FFT module doesn't exist as an object, so there is no code path, traced or otherwise,
that could ever reach `torch.fft.rfft`/`torch.topk` for these checkpoints. `resolution_prefix_tuning`
gates an unrelated feature (`freq_mod` embedding prefix), also `false` in all three configs and also
absent from every exported graph.

Confirmed empirically on all three exported `.onnx` files (script: `check_onnx_graph.py`,
`onnx.checker.check_model` + a full node-type histogram including recursive subgraph traversal for
`Loop`/`If` bodies — none exist, so there are no subgraphs to recurse into):

| ctx | `onnx.checker` (full_check) | `Fft`/`Rfft`/`TopK`/`Loop`/`If`/`Scan` nodes found |
|---|---|---|
| 512 | PASS | **none** |
| 1024 | PASS | **none** |
| 1536 | PASS | **none** |

Full op histogram (identical set of op types across all three, only counts differ with graph size):
`Add, Clip, Concat, Constant, Div, Erf, LayerNormalization, MatMul, Mul, Pow, ReduceSum, Reshape,
Shape, Slice, Softmax, Sqrt, Sub, Transpose, Unsqueeze` — 19 distinct ops total, all standard,
well-supported ONNX primitives (`Erf`/`Softmax`/`LayerNormalization` from GELU/gated-attention/
layernorm; no custom op registration needed anywhere).

## 4. Export (Step 2) — and the adaptive-patching reshape bug

**Adapter:** a plain `nn.Module` wrapping `model(past_values=past_values, return_dict=True).prediction_outputs`
— no other forward args needed (all default to `None`/`False`), unlike Kronos's four separate
sub-graph adapters.

**Export command** (`torch.onnx.export`, legacy TorchScript tracer, matching the Kronos-precedent
methodology exactly):

```python
torch.onnx.export(
    adapter, (dummy_past_values,), out_path,
    input_names=["past_values"], output_names=["forecast"],
    opset_version=18, dynamo=False, do_constant_folding=True,
)
```

where `dummy_past_values = torch.randn(1, context_length, 1, dtype=torch.float32)` — **no
`dynamic_axes` argument at all**, batch fixed at 1, exactly the brief's fixed-shape requirement.

**First attempt failed at `onnxruntime` load time** (not at `torch.onnx.export` time — the export
itself reported no errors, only the usual fixed-shape `TracerWarning`s about baking `.shape[i]` as
constants):

```
onnxruntime.capi.onnxruntime_pybind11_state.Fail: [ONNXRuntimeError] : 1 : FAIL :
Load model from .../ttm_512_96.onnx failed:
Node (.../mixers.0/mixer_layers.0/patch_mixer/mlp/fc1/MatMul) Op (MatMul)
[ShapeInferenceError] Incompatible dimensions for matrix multiplication
```

Root-caused by walking the graph backward from the failing `MatMul` to the `Reshape` feeding it: the
upstream `TinyTimeMixerAdaptivePatchingBlock.forward` builds its reshape target as a Python tuple of
traced-shape-proxy arithmetic:

```python
hidden = torch.reshape(hidden, (hidden.shape[0], hidden.shape[1],
                                 hidden.shape[2] * self.adaptive_patch_factor,
                                 hidden.shape[3] // self.adaptive_patch_factor))
```

For the 512-context checkpoint's level-2 adaptive-patching block (`adaptive_patch_factor=4`, real
runtime input shape `(1, 1, 8, 192)`, confirmed via a forward hook), the *correct* reshape target is
`(1, 1, 32, 48)`. Dumping the actual baked `Constant` feeding that `Reshape` node in the exported
graph showed `[1, 8, 4, 48]` — the tracer recorded `num_patch` (8) and the bare `adaptive_patch_factor`
(4) as **two separate dimensions** instead of folding their product into one, corrupting every
downstream shape in that block. Reproduced identically with `do_constant_folding=False`, ruling out
the constant-folding pass as the cause — the bug is in the legacy tracer's handling of this specific
mixed multiply/divide-of-traced-shape-proxies expression, not in ONNX Runtime or in TTM's actual
numerics (eager PyTorch computes the correct `(1,1,32,48)` at real runtime, confirmed via a forward
hook printing live shapes).

**Fix (export-time only, upstream `granite-tsfm` untouched):** monkey-patch
`TinyTimeMixerAdaptivePatchingBlock.forward` to force each shape component through Python's `int()`
before the multiply/divide, so the tracer bakes the already-computed product/quotient as a single
constant instead of recording the arithmetic expression:

```python
b, c, p, d = int(hidden.shape[0]), int(hidden.shape[1]), int(hidden.shape[2]), int(hidden.shape[3])
hidden = torch.reshape(hidden, (b, c, p * factor, d // factor))
```

**Verified behaviorally neutral** (`verify_export_patch.py`): ran eager PyTorch with and without the
patch, same random input, all three context lengths — **bit-identical output, max abs diff 0.0** in
every case. Same pattern as the Kronos spike's own export-time `is_causal`/`attn_mask` SDPA patch:
a tracer-only workaround, verified not to change model behavior before being trusted.

After the patch, re-export succeeded and **all three graphs load and pass full-check**:

| Checkpoint | Export result | `.onnx` size | Inputs | Outputs |
|---|---|---|---|---|
| `ttm_512_96.onnx` | OK | 3,358,106 B (3.36 MB) | `past_values` f32 `[1,512,1]` | `forecast` f32 `[1,96,1]` |
| `ttm_1024_96.onnx` | OK | 12,003,001 B (12.0 MB) | `past_values` f32 `[1,1024,1]` | `forecast` f32 `[1,96,1]` |
| `ttm_1536_96.onnx` | OK | 12,478,481 B (12.5 MB) | `past_values` f32 `[1,1536,1]` | `forecast` f32 `[1,96,1]` |

All three: `opset 18`, `ir_version 8`, all input/output dims fully static (no `dim_param`, confirmed
via direct graph inspection — no dynamic axes anywhere, not even a batch dimension).

## 5. Normalization to replicate — but it doesn't need replicating in Rust

`TinyTimeMixerStdScaler` (`modeling_tinytimemixer.py`), invoked once at the start of
`TinyTimeMixerModel.forward` and reversed once at the end of `TinyTimeMixerForPrediction.forward`:

```
observed = ones_like(past_values)                      # no missing-value masking used at inference
loc      = sum(data * observed, dim=1, keepdim=True) / sum(observed, dim=1, keepdim=True)
variance = sum(((data - loc) * observed) ** 2, dim=1, keepdim=True) / sum(observed, dim=1, keepdim=True)
scale    = sqrt(variance + 1e-5)                        # epsilon INSIDE the sqrt, not added after
normalized = (data - loc) / scale                       # applied before patchify
...
forecast = normalized_forecast * scale + loc            # applied once, after the prediction head
```

Per-instance, per-channel (dim=1 is the time axis; `keepdim=True`), **population variance** (divide
by count, not count−1), `minimum_scale = 1e-5` added inside the square root. This is functionally
RevIN, computed fresh from the input window every call (no learned affine parameters, no running
statistics).

**Because this normalization is pure elementwise arithmetic (`ReduceSum`/`Div`/`Sub`/`Pow`/`Sqrt`/`Mul`/
`Add` — all present in the op histogram above), it was kept in-graph**, per the brief's stated
preference. **Practical consequence for Rust integration: no scaler math needs to be reimplemented at
all.** `ort` feeds raw closes in (`past_values`, un-normalized) and reads raw closes out (`forecast`,
already denormalized) — unlike an architecture that expects pre-normalized input. The formula above is
recorded here only so Rust can independently reproduce `loc`/`scale` for logging/debugging/sanity
checks if wanted later, not because it's required for correct output.

## 6. Cross-validation (Step 4) — GO bar cleared by 3+ orders of magnitude

`validate_and_build_fixtures.py`: for each checkpoint, took the trailing `context_length` closes from
a single shared 1536-bar synthetic fixture window (see §7), ran PyTorch eager and `onnxruntime`
(`CPUExecutionProvider`) on the identical raw input, compared the full 96-step forecast:

| ctx | max abs err | max rel err | GO bar (`<1e-3`) |
|---|---|---|---|
| 512 | 4.883e-04 | **2.386e-07** | PASS |
| 1024 | 7.324e-04 | **3.426e-07** | PASS |
| 1536 | 4.883e-04 | **2.257e-07** | PASS |

(Absolute errors look large only because the forecast values themselves are ~2000-2200 in this
fixture's price scale — the *relative* error, which is what the brief's GO bar is defined on, is
~1e-7, ordinary float32 CPU-kernel-ordering noise between PyTorch's and ONNX Runtime's
matmul/layernorm implementations.)

`onnx.checker.check_model(..., full_check=True)` passed for all three (§4). No `Loop`/`If` anywhere in
any graph (§3), so there is no dynamic-shape correctness question analogous to Kronos's
`dynamic_axes` finding — every checkpoint is a genuinely static graph by construction.

**CPU latency** (informal, this development machine, not the target i5 — `onnxruntime`,
`CPUExecutionProvider`, mean over 50 runs after 5 warmup runs):

| ctx | mean latency |
|---|---|
| 512 | 0.49 ms |
| 1024 | 0.80 ms |
| 1536 | 1.02 ms |

Sub-2ms per checkpoint even unoptimized — comfortably inside the dossier's already-generous ~10-200ms
estimate for the target i5, and far cheaper than Kronos's per-candle autoregressive cost.

## 7. Reference fixture (Step 5)

Real market data of sufficient length (1536+ contiguous closes) was not available in this repo's
existing fixtures (`kaggle_banknifty_minute_sample.csv` is a 3-row sample; `synthetic_bhavcopy_infy.csv`
is 320 rows) or reused inline from the Kronos spike's 256-bar fixture (too short for the 1536-context
checkpoint). Generated a **deterministic seeded synthetic** close-price series instead (GBM-like log-
return random walk, seed `20260720`, 1536 bars, 5-minute spacing) — documented as synthetic, not real
market data, matching the honesty standard of the Kronos spike report (which flagged its own gaps
explicitly). The numeric-parity question this spike answers (does the ONNX graph reproduce PyTorch
eager) does not depend on the input being real market data, only on it being a realistic,
reproducible, non-degenerate float32 series.

Files written to the working tree (**not committed** — per this task's brief, for a future task to
commit alongside the Rust unit tests):

- `rust-core/crates/algo-core/tests/fixtures/ttm_context.csv` — 1536 rows, `timestamp_utc_naive,close`.
  All three checkpoints consume the trailing `N` rows of this **one shared file** (last 512 for the
  512-checkpoint, last 1024 for the 1024-checkpoint, all 1536 for the 1536-checkpoint) — this exactly
  matches the ensemble design (§8): "the same window" through all three checkpoints means the same
  underlying price history, each model seeing as much of it as its own `context_length` allows.
- `rust-core/crates/algo-core/tests/fixtures/ttm_expected_512.csv`,
  `ttm_expected_1024.csv`, `ttm_expected_1536.csv` — 96 rows each (`step,forecast_close`), the
  `onnxruntime` output for that checkpoint on its trailing window (PyTorch agrees to the rel-err in
  §6, so either reference is valid; the ONNX output was chosen since that's what Rust `ort` will
  actually produce, mirroring the Kronos precedent's reasoning for regenerating its own fixture
  through the validated pipeline rather than an upstream CSV).

Export/validation scripts + the two vendored TTM source files + downloaded configs kept at
`__references/granite-tsfm-ttm-export/` (gitignored) for reproducibility:
`common.py` (model loading + adapter + the export patch), `download_checkpoints.py`,
`export_ttm_onnx.py`, `check_onnx_graph.py`, `validate_and_build_fixtures.py`,
`gen_synthetic_closes.py`, `verify_export_patch.py`, `ttm_model/` (vendored modeling/config source),
`configs/` (the three real downloaded `config.json`s).

## 8. Conviction strategy — ensemble directional agreement (Step 6)

Per the dossier's recommended first-cut design (TTM-r2 is a deterministic point-forecaster, `loss:
"mse"`, no native uncertainty estimate): run the **same underlying close history** through all three
checkpoints (512/1024/1536 context, all sharing `prediction_length=96` — a genuinely convenient
property, since it means the ensemble compares forecasts at the *same* horizon despite different
context lengths, no horizon-alignment logic needed), and derive:

- **direction** per checkpoint: `sign(forecast_close[t+96] - last_close)`
- **conviction**: fraction of the three checkpoints agreeing on `direction`
  (`1.0` = unanimous, `0.33`/`0.67` = split, never exactly `0.5` with an odd ensemble size)
- **magnitude dispersion**: `std()` of the three checkpoints' `forecast_return` — a secondary
  "how much do they agree on *how much*" signal alongside the primary direction-agreement conviction

Demonstrated end-to-end on the fixture window (§7's synthetic downward-drifting series):

| ctx | `last_close` | `forecast[t+96]` | `return` | direction |
|---|---|---|---|---|
| 512 | 2202.3250 | 2048.1194 | −7.00% | down |
| 1024 | 2202.3250 | 2122.7329 | −3.61% | down |
| 1536 | 2202.3250 | 2181.9258 | −0.93% | down |

**Directional agreement: 3/3 → conviction 1.00.** Magnitude dispersion (std of the three returns):
2.49% — illustrating the secondary signal: all three agree on direction here, but the *magnitude*
disagreement (−7.0% vs. −0.9%) would be worth surfacing alongside the conviction score rather than
collapsing to a single number, so a consumer can distinguish "strong unanimous conviction, tight
magnitude agreement" from "unanimous direction, wildly disagreeing on how much."

**Required lookback per checkpoint:** exactly `context_length` bars (512/1024/1536) — the exported
graphs have no in-graph padding/truncation (confirmed: the fixed-shape trace froze the
equal-length branch of the upstream truncate/pad `if`/`elif`, discussed in §2), so Rust must always
supply exactly that many real bars per checkpoint, and the *ensemble's* overall required lookback is
the max across the checkpoints actually used (1536, if running all three).

**Degrade-gracefully policy** (not yet implemented, documented as the integration-time design): if
fewer than 1536 bars of history are available (e.g., early in a newly-listed instrument's life), drop
the checkpoints whose `context_length` exceeds what's available rather than padding/faking history,
and reduce the ensemble size (and therefore the conviction denominator) accordingly — e.g., only
512+1024 available → conviction is "2/2 agree" not "2/3, treating the missing one as silently absent."
This mirrors the same "model opinion, not a bare verdict" evidence-labeling convention used for
Kronos's `AlgoOutput`.

**Multivariate note:** the exported graphs are fixed at `num_input_channels=1` (this spike's close-only
MVP). Per the dossier, the backbone is channel-independent, so a second channel (e.g. `volume`) is
architecturally supported and would export the same way at a different fixed input shape
(`[1, context_length, 2]`) — but it is a **separate export per channel count**, not a runtime option on
today's graphs, and (per the dossier) shipped weights don't model cross-channel interaction anyway
(channel-mixing decoder is off) — not pursued in this spike, out of scope for the close-only MVP.

## 9. What was NOT covered (honest gaps, given the timebox)

- **No Rust `ort` validation was performed in this spike** — the brief's Step 4 asks for
  "onnxruntime (Python) then via Rust `ort`," but per this task's own top-level constraint (pure
  Python feasibility spike, no cargo/Rust builds), only the Python `onnxruntime` cross-validation
  (§6) was done. The Kronos precedent shows this is very likely to carry over cleanly (same
  op set, same opset 18, same `ort` crate would load these), but it is not independently confirmed
  here and should be the first thing a Rust implementation task checks.
- Real market data was not used for the reference fixture (§7) — a synthetic, seeded series was
  substituted, documented explicitly rather than silently.
- The "degrade gracefully with less than 1536 bars of history" ensemble policy (§8) is a documented
  design, not implemented/tested code.
- Latency was measured on this development machine, not the target 11th-gen i5 (§6) — expected to be
  well within budget either way given the sub-2ms measured figures and the dossier's already-generous
  CPU estimate, but not independently confirmed on the exact target hardware.
- The `TinyTimeMixerAdaptivePatchingBlock` export patch (§4) was verified against eager PyTorch
  (bit-identical) and against `onnxruntime`'s own numeric output (§6's rel-err), but not against any
  third implementation — standard practice, same rigor level as the Kronos spike's own export-time
  patch, not a novel gap.

## Reproducibility

- `granite-tsfm` repo: `github.com/ibm-granite/granite-tsfm`, cloned fresh via `git clone --depth 1`
  (Apache-2.0); modeling/config source read at whatever commit `main` pointed to on 2026-07-20 (not
  independently pinned to a commit hash — same caveat the Kronos spike noted for its own upstream
  clone).
- Checkpoints: `ibm-granite/granite-timeseries-ttm-r2` @ revisions `main` (512-96-r2), `1024-96-r2`,
  `1536-96-r2` (Apache-2.0).
- Tooling versions: Python 3.12.13, `torch==2.13.0` (CPU), `onnx==1.22.0`, `onnxruntime==1.27.0`,
  `transformers==5.14.1`, `huggingface_hub==0.33.1`, `safetensors==0.6.2`, `numpy==2.5.1`.
- All scripts, configs, and the vendored two-file model source are saved at
  `__references/granite-tsfm-ttm-export/` (gitignored, reproducible re-run point); fixtures are at
  `rust-core/crates/algo-core/tests/fixtures/ttm_{context,expected_512,expected_1024,expected_1536}.csv`
  (working tree, not committed, per this task's instructions).
