---
name: index-status
description: >
  Use when the user asks how far the ai-context plugin's indexing is, wants to
  watch indexing progress live, or reports high RAM/CPU/fan noise while the
  ai-context-opencode-plugin indexes a repo. Reads
  .opencode/ai-context/index-status.json (works under ACP/JetBrains AI
  Assistant, macOS without `watch`) and explains phase, ETA, skipped files and
  the memory/exclude knobs in .opencode/ai-context.config.yaml.
---
<!-- managed-by: ai-context-opencode-plugin -->

# Index status — follow and tune plugin indexing

The plugin writes `.opencode/ai-context/index-status.json` in the project
worktree (atomically, at most every 2 s). It is the only progress channel that
works under ACP; OS popups only mark start/finish/failure.

## 1. Read it once

```bash
cat .opencode/ai-context/index-status.json
```

Fields: `phase` (`idle|scanning|loading-model|indexing|done|failed`), `done`,
`total`, `percent`, `etaSeconds`, `filesPerSec`, `currentFile`, `failed`,
`failures[]` (file, error, attempts), `lastError`.

## 2. Live view: give the user the command

When the user wants to follow progress live, do this and nothing more:

1. Read the JSON file once (step 1) and report phase, percent, ETA and
   failures in a few lines.
2. Give the user this command to run in their own terminal (replace
   `<worktree>` with the absolute project path):

```bash
<worktree>/.opencode/skills/index-status/scripts/watch-index-status.sh
```

NEVER run `watch-index-status.sh` yourself, with any tool: it loops forever,
blocks or aborts your call, and the user cannot see its output. macOS has no
`watch`; the script (uses `jq` if present, plain `cat` otherwise) is the
replacement. Do not start loops or background watchers either.

## 3. Interpret

- `loading-model`: first embedding call downloads/loads the model; normal, one time.
- `failed` + `lastError` mentioning `max_memory_mb`: the memory guard stopped
  indexing. Lower `embed_max_tokens`/`max_file_bytes` or raise `max_memory_mb`.
- `failures[]` with `skipped: file is N bytes`: file over `max_file_bytes`; it is
  skipped and retried automatically when it changes.
- Fan/CPU high: lower `embed_threads` (default 2).
- Noise from generated/legacy code: add patterns to `exclude:`.

All keys live in `.opencode/ai-context.config.yaml` (auto-created, commented).
Restart opencode after editing it.
