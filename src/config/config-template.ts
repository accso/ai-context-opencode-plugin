import fs from "node:fs";
import path from "node:path";
import { resolveConfigFilePath } from "./config-file.js";

/**
 * Template written on first start so users see every knob with its built-in default.
 * `enabled: false` makes the plugin opt-in per repository. Machine-specific keys
 * (data_dir, model_cache_dir, embed_dims) and optional ones (exclude, heavy_mode)
 * stay commented out. Values must equal the built-in defaults (config-template.test.ts).
 */
export const CONFIG_TEMPLATE = `# .opencode/ai-context.config.yaml -- created by ai-context-opencode-plugin.
# Every setting is shown with its built-in default; edit a value to change it.
# Precedence: environment variable > this file > built-in default.

# Master switch for this repository. false (also when the key is missing): the
# plugin does nothing here (no indexing, no tools, no background work) and only
# keeps this file. Set it to true to switch the plugin on. The environment
# variable AI_CONTEXT_PLUGIN_ENABLED (1/0) overrides it.
enabled: false

# Extra paths that are never indexed (gitignore syntax, on top of .gitignore).
# Applies to the startup scan, the file watcher and the indexer; excluded
# directories are not descended into. Stored chunks of newly excluded files are
# removed when the file is re-indexed.
# exclude:
#   - legacy/
#   - "*.generated.ts"

# Soft RSS ceiling (MiB) of the host process while indexing; over it, indexing
# stops with an error in .opencode/ai-context/index-status.json. A guard, not a hard
# cap (a process cannot cap itself); the real bound is embed_max_tokens.
max_memory_mb: 6144

# Threads onnxruntime uses for embedding (lower = less CPU/fan).
embed_threads: 6

# Files indexed in parallel; also the number of inferences the shared worker runs at
# once (each costs transient RAM). 1 = sequential.
embed_concurrency: 3

# Token cap per embedded text; memory grows quadratically with it (512 tokens
# ~0.5 GB, 4096 ~4.5 GB). Chunks are split to fit.
embed_max_tokens: 512

# Files larger than this many bytes are skipped.
max_file_bytes: 1048576

# Native OS popups (plugin started, indexing started/finished/failed).
# Environment variable: AI_CONTEXT_OS_NOTIFICATIONS=0 silences them.
os_notifications: true

# Append a short hint to the agent's system prompt so it prefers semantic_search /
# analyze_impact over grep/glob for conceptual questions.
agent_hint: true

# Protocol every tool call (tool, arguments, short response summary) to
# .opencode/ai-context/tool.log.md (git-ignored; at 5 MB it is rotated to tool.<time>.log.md, newest 10 kept). For finding out
# why the agent chose or misused a tool.
tool_log: false

# With tool_log: no truncation at all, complete arguments and complete response text.
# Code from the repo (and from linked repos) then ends up in the log file.
tool_log_full_responses: false

# Re-rank the best search candidates with a small cross-encoder model
# (Xenova/ms-marco-MiniLM-L-6-v2, ~23 MB, downloaded once, runs in the shared
# worker). Improves the order of results at a few ms per candidate.
reranker: true

# Index one summary chunk per file with several chunks, so "what does this file
# do" questions hit the file. Deterministic (symbols + leading comment) unless
# summary_llm is set.
file_summaries: true

# File summaries are written by an OpenAI-compatible server (the local oMLX server
# below by default). File content is sent to base_url, so keep it local. model is
# the exact name the server lists. The API key is NEVER stored here (this file is
# meant to be committed): export it as the environment variable named by
# api_key_env, e.g. export AI_CONTEXT_SUMMARY_LLM_API_KEY=<your key>. Without a
# variable no key is sent; an HTTP 401 then tells you to set it. Unreachable or
# failing server: deterministic summaries are used and rewritten on a later start
# once it answers.
# Set "summary_llm: false" to never call an LLM. For LM Studio use e.g.
# base_url http://127.0.0.1:1234/v1 with model qwen2.5-coder-3b-instruct-mlx
# (no key needed).
summary_llm:
  base_url: http://127.0.0.1:8000/v1
  model: Qwen2.5-Coder-3B-Instruct-MLX-4bit
  api_key_env: AI_CONTEXT_SUMMARY_LLM_API_KEY
  # timeout_ms: 60000

# One-off re-indexing on the next start; the plugin sets the flag back to false
# once the run finished. reindex_chunks re-chunks and re-embeds every file (keeping
# the stored summaries), reindex_summaries rewrites the file summaries only (use it
# after the summary LLM was down), both true re-indexes everything.
reindex_chunks: false
reindex_summaries: false

# Run the embedding model in ONE shared background process (started on demand,
# shared by all opencode instances, exits when idle or above max_memory_mb)
# instead of inside opencode. Falls back to in-process if it cannot start.
# Environment variable: AI_CONTEXT_SHARED_WORKER=0 disables it.
shared_worker: true

# Install the bundled index-status skill into .opencode/skills of this
# project (a SKILL.md you edited yourself is never overwritten).
# Environment variable: AI_CONTEXT_INSTALL_SKILLS=0 disables it.
install_skills: true

# Where the per-project SQLite index lives; must be OUTSIDE the worktree (else the
# plugin's own writes re-trigger indexing; this is not validated).
# Environment variable: AI_CONTEXT_PLUGIN_DATA_DIR. Default: ~/.local/share/ai-context-opencode-plugin
# data_dir: /Users/me/.local/share/ai-context-opencode-plugin

# Embedding model cache; unset = the shared Hugging Face cache (one copy of the
# model for all tools). Only set it for a plugin-private or air-gapped cache.
# Environment variable: AI_CONTEXT_PLUGIN_MODEL_CACHE_DIR
# model_cache_dir: /Users/me/.cache/ai-context-plugin/models

# Matryoshka truncation of the 768-dim vectors (positive integer <= 768): faster
# search on big repos, slightly lower quality; changing it requires a re-index.
# Environment variable: AI_CONTEXT_PLUGIN_EMBED_DIMS
# embed_dims: 256

# Reserved for future heavy-mode-only features (no effect today).
# Environment variable: AI_CONTEXT_PLUGIN_HEAVY_MODE
# heavy_mode: false
`;

/** Writes the template if the config file is missing. Never overwrites; never throws. Returns true if created. */
export function ensureConfigFile(
  worktree: string,
  onError?: (error: unknown) => void,
): boolean {
  try {
    if (!fs.existsSync(worktree)) return false;
    const filePath = resolveConfigFilePath(worktree);
    if (fs.existsSync(filePath)) return false;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, CONFIG_TEMPLATE, { flag: "wx" });
    return true;
  } catch (error) {
    onError?.(error);
    return false;
  }
}

/**
 * Switches `reindex_chunks: true` / `reindex_summaries: true` back to false in place (comments and
 * other lines stay). Never throws; returns true when the file was changed.
 */
export function resetReindexFlags(
  worktree: string,
  onError?: (error: unknown) => void,
): boolean {
  try {
    const filePath = resolveConfigFilePath(worktree);
    if (!fs.existsSync(filePath)) return false;
    const content = fs.readFileSync(filePath, "utf8");
    const updated = content.replace(
      /^(\s*reindex_(?:chunks|summaries)\s*:\s*)true\b/gim,
      (_match, prefix: string) => `${prefix}false`,
    );
    if (updated === content) return false;
    fs.writeFileSync(filePath, updated);
    return true;
  } catch (error) {
    onError?.(error);
    return false;
  }
}
