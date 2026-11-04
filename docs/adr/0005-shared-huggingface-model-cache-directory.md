# ADR-0005: Download the embedding model into Hugging Face's shared cache, not a plugin-private directory

## Status

Accepted (port-semantic-search-tool, 2026-09).

## Context

The embedding pipeline (ADR-0004) needs to download and cache a ~137MB
quantized ONNX model plus its tokenizer config. The download uses
`@huggingface/hub`'s `downloadFileToCacheDir`, which accepts an
optional `cacheDir` parameter. If left unset, it uses the SAME standard
shared cache location (`$HF_HOME/hub`, `~/.cache/huggingface/hub` by
default) that Python's `huggingface_hub`/`transformers`/
`sentence-transformers` and JS's `@huggingface/transformers` all use.

The user separately runs (or may run) other OpenCode plugins that also
embed with `nomic-embed-text-v1.5` or other HF-hosted models.

## Decision

Leave `cacheDir` unset by default (`resolveModelCacheDir` returns
`undefined` unless overridden), so the download lands in HF's own
standard shared, content-addressed cache rather than a
plugin-private directory. `AI_CONTEXT_PLUGIN_MODEL_CACHE_DIR` remains
as an explicit opt-out for locked-down/air-gapped setups that want a
private, fully plugin-owned cache instead.

## Consequences

- If another OpenCode plugin (or any other HF-ecosystem tool on the
  same machine) also embeds with `nomic-embed-text-v1.5`, it downloads
  the exact same content-addressed blob once, and every consumer
  reuses it -- no duplicate ~137MB downloads per plugin.
- This is deliberately DIFFERENT from the per-project vector-store
  files (ADR-0003): the model is shared, static, non-project-specific
  data, so there's no isolation benefit to duplicating it the way
  per-project data must be kept separate.
- A user on a locked-down/air-gapped machine, or one who wants strict
  per-plugin disk isolation for any reason, can still force a private
  cache via `AI_CONTEXT_PLUGIN_MODEL_CACHE_DIR` without any code
  changes.

## Alternatives considered

- **A plugin-private cache directory by default (e.g. under
  `~/.local/share/ai-context-opencode-plugin/models/`).** Rejected as
  the default: guarantees duplicate downloads across independently
  developed plugins using the same public model, for no isolation
  benefit, since the artifact itself has no per-project or per-plugin
  sensitive content.
