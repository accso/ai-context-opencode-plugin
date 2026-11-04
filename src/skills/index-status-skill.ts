/**
 * The `index-status` skill shipped by the plugin (single source of truth).
 * The plugin cannot read files next to its bundle at runtime, so the content
 * is embedded.
 */
export const SKILL_MANAGED_MARKER =
  "<!-- managed-by: ai-context-opencode-plugin -->";

/** Marker written before the plugin was renamed; copies carrying it are still managed (and get refreshed). */
export const LEGACY_SKILL_MANAGED_MARKER =
  "<!-- managed-by: opencode-ai-context-plugin -->";

export const INDEX_STATUS_SKILL_MD =
  '---\nname: index-status\ndescription: >\n  Use when the user asks how far the ai-context plugin\'s indexing is, wants to\n  watch indexing progress live, or reports high RAM/CPU/fan noise while the\n  ai-context-opencode-plugin indexes a repo. Reads\n  .opencode/ai-context/index-status.json (works under ACP/JetBrains AI\n  Assistant, macOS without `watch`) and explains phase, ETA, skipped files and\n  the memory/exclude knobs in .opencode/ai-context.config.yaml.\n---\n<!-- managed-by: ai-context-opencode-plugin -->\n\n# Index status — follow and tune plugin indexing\n\nThe plugin writes `.opencode/ai-context/index-status.json` in the project\nworktree (atomically, at most every 2 s). It is the only progress channel that\nworks under ACP; OS popups only mark start/finish/failure.\n\n## 1. Read it once\n\n```bash\ncat .opencode/ai-context/index-status.json\n```\n\nFields: `phase` (`idle|scanning|loading-model|indexing|done|failed`), `done`,\n`total`, `percent`, `etaSeconds`, `filesPerSec`, `currentFile`, `failed`,\n`failures[]` (file, error, attempts), `lastError`.\n\n## 2. Live view: give the user the command\n\nWhen the user wants to follow progress live, do this and nothing more:\n\n1. Read the JSON file once (step 1) and report phase, percent, ETA and\n   failures in a few lines.\n2. Give the user this command to run in their own terminal (replace\n   `<worktree>` with the absolute project path):\n\n```bash\n<worktree>/.opencode/skills/index-status/scripts/watch-index-status.sh\n```\n\nNEVER run `watch-index-status.sh` yourself, with any tool: it loops forever,\nblocks or aborts your call, and the user cannot see its output. macOS has no\n`watch`; the script (uses `jq` if present, plain `cat` otherwise) is the\nreplacement. Do not start loops or background watchers either.\n\n## 3. Interpret\n\n- `loading-model`: first embedding call downloads/loads the model; normal, one time.\n- `failed` + `lastError` mentioning `max_memory_mb`: the memory guard stopped\n  indexing. Lower `embed_max_tokens`/`max_file_bytes` or raise `max_memory_mb`.\n- `failures[]` with `skipped: file is N bytes`: file over `max_file_bytes`; it is\n  skipped and retried automatically when it changes.\n- Fan/CPU high: lower `embed_threads` (default 2).\n- Noise from generated/legacy code: add patterns to `exclude:`.\n\nAll keys live in `.opencode/ai-context.config.yaml` (auto-created, commented).\nRestart opencode after editing it.\n';

export const INDEX_STATUS_WATCH_SCRIPT = [
  "#!/usr/bin/env bash",
  "# Live view of the ai-context plugin's index-status.json (macOS has no `watch`).",
  "# Usage: watch-index-status.sh [worktree]  (default: the worktree this skill lives in)",
  "set -u",
  "if [ -n \"${1:-}\" ]; then",
  "  worktree=\"$1\"",
  "else",
  "  worktree=\"$(cd \"$(dirname \"${BASH_SOURCE[0]}\")/../../../..\" && pwd)\"",
  "fi",
  "file=\"$worktree/.opencode/ai-context/index-status.json\"",
  "render() {",
  "  if [ ! -f \"$file\" ]; then",
  "    echo \"no status file yet: $file\"",
  "  elif command -v jq >/dev/null 2>&1; then",
  "    IFS=$'\\t' read -r phase running done_n total pct eta fps cur failed err < <(",
  "      jq -r '[.phase, .running, .done, .total, (.percent // 0), (.etaSeconds // \"-\"),",
  "              ((.filesPerSec // 0) * 100 | round / 100), (.currentFile // \"-\"),",
  "              .failed, (.lastError // \"-\")] | map(tostring) | join(\"\\t\")' \"$file\")",
  "    pct=${pct%.*}; [ \"$pct\" -gt 100 ] 2>/dev/null && pct=100",
  "    width=40; filled=$(( pct * width / 100 )); bar=\"\"",
  "    for ((i = 0; i < width; i++)); do",
  "      if [ \"$i\" -lt \"$filled\" ]; then bar+=\"█\"; else bar+=\"░\"; fi",
  "    done",
  "    echo \"phase: $phase (running: $running)\"",
  "    echo \"[$bar] ${pct}%  $done_n/$total files\"",
  "    echo \"eta: ${eta}s   speed: ${fps} files/s   failed: $failed\"",
  "    echo \"current: $cur\"",
  "    [ \"$err\" != \"-\" ] && echo \"last error: $err\"",
  "  else",
  "    cat \"$file\"",
  "  fi",
  "}",
  "[ -z \"${AI_CONTEXT_WATCH_ONCE:-}\" ] && printf '\\033[2J\\033[?25l' && trap 'printf \"\\033[?25h\"' EXIT",
  "while true; do",
  "  frame=\"$(render)\"",
  "  # home cursor, overwrite in place, erase line tails and leftovers: no flicker",
  "  printf '\\033[H%s\\033[K\\n\\033[J' \"${frame//$'\\n'/$'\\033[K\\n'}\"",
  "  [ -n \"${AI_CONTEXT_WATCH_ONCE:-}\" ] && exit 0",
  "  sleep 1",
  "done",
  "",
].join("\n");
