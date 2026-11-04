# Installation

The plugin is one bundled file plus one worker script, installed into
opencode's **global** config directory so one install covers every repo
([ADR-0015](adr/0015-single-bundled-plugin-file.md)).

```bash
npm install
npm run build              # dist/accso-ai-context.js + dist/ai-context-worker.mjs
./scripts/install-plugin.sh
# or, on a fresh machine: mise install && mise run setup
#   (setup runs npm install, build and the installer; mise install provides Node 22)
```

Then restart opencode (all running instances). On OpenCode 2.x the plugin is reloaded automatically (or run `/reload`); 1.x needs a restart.

## What the installer does

| Target | Content |
| --- | --- |
| `~/.config/opencode/plugins/accso-ai-context.js` | the plugin bundle |
| `~/.config/opencode/ai-context-worker.mjs` | shared embedding worker (kept outside `plugins/` on purpose: opencode loads every file there as a plugin) |
| `~/.config/opencode/package.json` | merged native dependencies (`onnxruntime-node`, `tokenizers`, tree-sitter grammars, ...) |

It runs `bun install` there (npm as fallback) and verifies every package,
including each grammar's `.wasm`; it exits non-zero otherwise. Set
`SKIP_DEPS_INSTALL=1` to leave dependency installation to opencode's next
start. Re-running is safe: only this plugin's own entries are touched.

## First start

- The embedding model (~137 MB, quantized ONNX) is downloaded once into the
  shared Hugging Face cache ([ADR-0005](adr/0005-shared-huggingface-model-cache-directory.md)).
- `.opencode/ai-context.config.yaml` is created if missing (every setting with
  its default, `enabled: false`, never overwritten). **The plugin does nothing
  in a repository until you set `enabled: true` there** (or start opencode with
  `AI_CONTEXT_PLUGIN_ENABLED=1`). Once enabled, it also creates `.opencode/.gitignore` (volatile status file) and the
  `index-status` and `cross-repo` skills under `.opencode/skills/`. The `.opencode` folder is
  created if it does not exist.
- The first index of a repo can take minutes; follow it in
  `.opencode/ai-context/index-status.json` or via `index_status`.

## Updating

Rebuild, re-run `install-plugin.sh`, restart opencode (2.x: reloads on its own). The shared worker is
replaced automatically once the old one exits (idle 10 min) or you stop it.

## Uninstalling

Remove the two files above and, if wanted, the data directory
`~/.local/share/ai-context-opencode-plugin/`.
