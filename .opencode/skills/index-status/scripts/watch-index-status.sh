#!/usr/bin/env bash
# Live view of the ai-context plugin's index-status.json (macOS has no `watch`).
# Usage: watch-index-status.sh [worktree]  (default: the worktree this skill lives in)
set -u
if [ -n "${1:-}" ]; then
  worktree="$1"
else
  worktree="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
fi
file="$worktree/.opencode/ai-context/index-status.json"
render() {
  if [ ! -f "$file" ]; then
    echo "no status file yet: $file"
  elif command -v jq >/dev/null 2>&1; then
    IFS=$'\t' read -r phase running done_n total pct eta fps cur failed err < <(
      jq -r '[.phase, .running, .done, .total, (.percent // 0), (.etaSeconds // "-"),
              ((.filesPerSec // 0) * 100 | round / 100), (.currentFile // "-"),
              .failed, (.lastError // "-")] | map(tostring) | join("\t")' "$file")
    pct=${pct%.*}; [ "$pct" -gt 100 ] 2>/dev/null && pct=100
    width=40; filled=$(( pct * width / 100 )); bar=""
    for ((i = 0; i < width; i++)); do
      if [ "$i" -lt "$filled" ]; then bar+="█"; else bar+="░"; fi
    done
    echo "phase: $phase (running: $running)"
    echo "[$bar] ${pct}%  $done_n/$total files"
    echo "eta: ${eta}s   speed: ${fps} files/s   failed: $failed"
    echo "current: $cur"
    [ "$err" != "-" ] && echo "last error: $err"
  else
    cat "$file"
  fi
}
[ -z "${AI_CONTEXT_WATCH_ONCE:-}" ] && printf '\033[2J\033[?25l' && trap 'printf "\033[?25h"' EXIT
while true; do
  frame="$(render)"
  # home cursor, overwrite in place, erase line tails and leftovers: no flicker
  printf '\033[H%s\033[K\n\033[J' "${frame//$'\n'/$'\033[K\n'}"
  [ -n "${AI_CONTEXT_WATCH_ONCE:-}" ] && exit 0
  sleep 1
done
