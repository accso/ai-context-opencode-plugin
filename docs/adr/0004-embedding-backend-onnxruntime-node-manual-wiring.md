# ADR-0004: Hand-rolled `onnxruntime-node` embedding pipeline instead of the npm `fastembed` package

## Status

Accepted, corrects an earlier plan (2026-09-15 audit).

## Context

The plugin needs an in-process embedding backend for
`nomic-ai/nomic-embed-text-v1.5` (chosen for its Matryoshka-truncatable
output and permissive license). The initial plan was to depend on the
npm `fastembed` package, since it promises exactly this: bundled ONNX
models + tokenization + pooling behind a simple `EmbeddingModel` API.

A pre-implementation audit (recorded in the session's `plan.md`,
"Auditing fastembed/nomic embedding fit") found two disqualifying
problems:

1. `fastembed`'s `EmbeddingModel` catalog **does not include nomic at
   all** -- there's no supported model identifier for
   `nomic-embed-text-v1.5`.
2. Even setting that aside, `fastembed`'s `getEmbeddings()` extraction
   is **hardcoded to the first token position (CLS pooling)**, not the
   attention-mask-weighted mean pooling `nomic-embed-text-v1.5` was
   actually trained with. Using it would silently produce degraded
   embeddings with no error -- the worst kind of failure for a
   retrieval-quality-sensitive feature.

Forking `fastembed-js` to add nomic support and fix pooling was also
considered and rejected: it would mean maintaining a fork of someone
else's abstraction for behavior that's actually quite small once
manually implemented.

## Decision

Hand-roll the embedding pipeline directly:

- `src/embedding/embedder.ts` implements the actual math this
  decision requires owning: attention-mask-weighted mean pooling
  (`meanPool`), L2 normalization (`l2Normalize`), and Matryoshka
  dimension truncation (`truncateMatryoshka`) -- injectable
  `tokenize`/`runInference` dependencies keep this module free of real
  I/O in unit tests.
- `src/embedding/model-runtime.ts` provides the REAL implementation of
  those two dependencies: `onnxruntime-node` for inference, the
  official `tokenizers` package for tokenization, and
  `@huggingface/hub`'s `downloadFileToCacheDir` for fetching the
  quantized ONNX export (`onnx/model_quantized.onnx`, ~137MB int8 vs.
  ~547MB fp32) and tokenizer config.
- `createLazyEmbedder` loads the tokenizer + ONNX session once, lazily
  (on first real `semantic_search`/indexing call, not at plugin
  startup), and shares that single loaded session between
  `embedQuery` and `embedDocument`.

Verified manually end-to-end (real download + real ONNX inference, not
part of the fast unit suite): the model's ONNX graph takes
`input_ids`/`token_type_ids`/`attention_mask` and returns a single
`last_hidden_state` output of shape `[1, seqLen, 768]`; L2 norm of the
resulting embedding was confirmed ≈ 1.

## Consequences

- No dependency on an abstraction whose model catalog and pooling
  strategy don't match this plugin's actual model -- the tradeoff is
  owning ~100 lines of pooling/normalization/truncation math directly,
  which is small and now unit-tested (`embedder.test.ts`).
- The int8-quantized model export is a deliberate quality/size
  trade-off: negligible retrieval-quality loss for a ~4x smaller
  download, matching the plugin's "no bundled heavy infra, keep it
  light" philosophy.
- Lazy loading means the first `semantic_search` call (or first
  indexing pass) in a session pays the model-load cost, not every
  OpenCode session start -- deliberate, since `semantic_search` may
  never be called in a given session.
- See ADR-0005 for the model *cache location* decision (a related but
  separate choice from the pipeline implementation itself).

## Alternatives considered

- **npm `fastembed` package as originally planned.** Rejected: wrong
  model catalog, wrong pooling strategy (silent quality degradation).
- **Forking `fastembed-js`.** Rejected: maintaining a fork for a
  relatively small amount of actual logic isn't worth the ongoing
  upstream-drift maintenance cost.
- **`@huggingface/transformers` (transformers.js).** Considered in the
  same audit as a heavier-but-more-complete alternative; not chosen
  because the plugin only needs a single fixed pipeline (tokenize ->
  ONNX inference -> pool -> normalize -> optionally truncate), which
  is small enough to own directly with narrower, more auditable
  dependencies (`onnxruntime-node` + `tokenizers` directly, rather than
  a larger all-in-one library).
