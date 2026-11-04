import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

/**
 * Project-level YAML config file (user-directed, 2026-09-16): a single,
 * team-committable place for every AI_CONTEXT_PLUGIN_* knob that
 * previously only had an env-var interface -- `data_dir`,
 * `model_cache_dir`, `embed_dims`, `heavy_mode`. Lives at
 * `.opencode/ai-context.config.yaml` inside the project worktree (see
 * `resolveConfigFilePath`), alongside this plugin's other `.opencode/`
 * metadata (repo-local backup, cross-repo allow-list).
 *
 * Precedence, per each setting's own consuming module (heavy-mode.ts,
 * model-runtime.ts, project-key.ts): explicit function option (tests) >
 * env var > this config file > built-in default -- "env vars become
 * overrides on top of the file" (user-directed). This module only
 * covers reading/parsing/validating the file itself; the actual
 * precedence merge happens where each setting is consumed.
 *
 * Deliberately fault-tolerant, matching this plugin's other
 * user-authored-file handling (`backup.ts`'s per-row validation): a
 * missing file, an empty file, unknown keys, wrong-typed values, or
 * outright malformed YAML all degrade to "no override from the file"
 * (logged, not thrown) rather than crashing the whole plugin over one
 * bad config line.
 */

/** OpenAI-compatible chat endpoint (LM Studio, Ollama, vLLM, OpenAI, ...) used to write file summaries. */
export interface SummaryLlmConfig {
  /** e.g. `http://localhost:1234/v1`; `/chat/completions` is appended. */
  baseUrl: string;
  /** Exact model identifier as the server knows it. */
  model: string;
  /** Name of the environment variable holding the API key; the key itself never lives in the file. */
  apiKeyEnv?: string;
  timeoutMs?: number;
}

/** Environment variable read for the summary LLM's API key unless `api_key_env` names another. */
export const DEFAULT_SUMMARY_LLM_API_KEY_ENV = "AI_CONTEXT_SUMMARY_LLM_API_KEY";

/** Used when `summary_llm` is absent; a local oMLX server. Unreachable servers fall back to deterministic summaries. */
export const DEFAULT_SUMMARY_LLM: SummaryLlmConfig = {
  baseUrl: "http://127.0.0.1:8000/v1",
  model: "Qwen2.5-Coder-3B-Instruct-MLX-4bit",
  apiKeyEnv: DEFAULT_SUMMARY_LLM_API_KEY_ENV,
};

export interface AiContextConfigFile {
  /**
   * Master switch for this repository; absent means off. While off the plugin only provides
   * this file and does nothing else. `AI_CONTEXT_PLUGIN_ENABLED` overrides it.
   */
  enabled?: boolean;
  /** AI_CONTEXT_PLUGIN_DATA_DIR equivalent -- see project-key.ts. */
  dataDir?: string;
  /** AI_CONTEXT_PLUGIN_MODEL_CACHE_DIR equivalent -- see model-runtime.ts. */
  modelCacheDir?: string;
  /** AI_CONTEXT_PLUGIN_EMBED_DIMS equivalent -- see model-runtime.ts. */
  embedDims?: number;
  /** AI_CONTEXT_PLUGIN_HEAVY_MODE equivalent -- see heavy-mode.ts. */
  heavyMode?: boolean;
  /** Soft RSS budget of the host process while indexing, in MiB -- see memory-guard.ts. */
  maxMemoryMb?: number;
  /** Threads used by onnxruntime for embedding (lower = less CPU/fan, slower indexing). */
  embedThreads?: number;
  /** Files embedded in parallel (also the worker's inference slots); default 3. */
  embedConcurrency?: number;
  /** Hard cap on tokens per embedded text; attention memory is quadratic in it -- see embedder.ts. */
  embedMaxTokens?: number;
  /** Extra paths never indexed, gitignore syntax (e.g. `legacy/`, `*.generated.ts`). */
  exclude?: string[];
  /** Install the bundled `index-status` skill into <worktree>/.opencode/skills. Default on. */
  installSkills?: boolean;
  /** Append a short usage hint for the context tools to the agent's system prompt. Default on. */
  agentHint?: boolean;
  /** Write every tool call (tool, arguments, response summary) to `.opencode/ai-context/tool.log.md`. Default off. */
  toolLog?: boolean;
  /** With `toolLog`: log complete arguments and responses without truncation (default: arguments cut at 200 chars, response only summarized). Default off. */
  toolLogFullResponses?: boolean;
  /** Re-rank search candidates with a cross-encoder model (small ONNX model, runs in the shared worker). Default on. */
  reranker?: boolean;
  /** Index one summary chunk per multi-chunk file (deterministic, or LLM-written with `summaryLlm`). Default on. */
  fileSummaries?: boolean;
  /** Optional LLM that writes the file summaries; deterministic summaries are used when absent or failing. */
  summaryLlm?: SummaryLlmConfig | false;
  /** One-off: re-chunk and re-embed every file on the next start, then the plugin resets the flag to false. */
  reindexChunks?: boolean;
  /** One-off: rewrite every file summary on the next start (both flags = full re-index); reset afterwards. */
  reindexSummaries?: boolean;
  /** Run the embedding model in one shared background process instead of inside opencode. Default on. */
  sharedWorker?: boolean;
  /** Native OS popups for indexing start/finish/failure and plugin load. Default on. */
  osNotifications?: boolean;
  /** OTLP metrics export (AI_CONTEXT_OTEL_ENABLED etc. override). Default off. */
  otelEnabled?: boolean;
  otelEndpoint?: string;
  otelFlushMs?: number;
  /** `project` label on exported metrics (AI_CONTEXT_PROJECT overrides). */
  project?: string;
  /** Files larger than this are skipped (typically generated/minified/bundled). */
  maxFileBytes?: number;
}

export interface ConfigFileFs {
  existsSync(filePath: string): boolean;
  readFileSync(filePath: string): string;
}

const realFs: ConfigFileFs = {
  existsSync: (filePath) => fs.existsSync(filePath),
  readFileSync: (filePath) => fs.readFileSync(filePath, "utf8"),
};

export function resolveConfigFilePath(worktree: string): string {
  return path.join(worktree, ".opencode", "ai-context.config.yaml");
}

function warn(
  filePath: string,
  reason: string,
  onProblem?: (message: string) => void,
): void {
  const message = `ignoring ${filePath}: ${reason}`;
  console.error(`[ai-context] ${message}`);
  onProblem?.(message);
}

/**
 * Reads and validates `.opencode/ai-context.config.yaml` for `worktree`.
 * Returns `{}` (meaning "no overrides from the file") if the file is
 * missing, empty, malformed YAML, not a mapping at the top level, or if
 * a given key is present but the wrong type -- each case logged via
 * `console.error` so a typo isn't silently invisible, but never thrown,
 * so a bad config file degrades to defaults/env-vars-only instead of
 * breaking the whole plugin.
 */
export function loadConfigFile(
  worktree: string,
  fsImpl: ConfigFileFs = realFs,
  onProblem?: (message: string) => void,
): AiContextConfigFile {
  const filePath = resolveConfigFilePath(worktree);
  if (!fsImpl.existsSync(filePath)) return {};

  const content = fsImpl.readFileSync(filePath);
  if (content.trim().length === 0) return {};

  let raw: unknown;
  try {
    raw = parseYaml(content);
  } catch (error) {
    warn(filePath, `malformed YAML (${(error as Error).message})`, onProblem);
    return {};
  }

  if (raw === null || raw === undefined) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    warn(
      filePath,
      "expected a YAML mapping (key: value pairs) at the top level",
      onProblem,
    );
    return {};
  }

  const obj = raw as Record<string, unknown>;
  const config: AiContextConfigFile = {};

  if (obj.enabled !== undefined) {
    if (typeof obj.enabled === "boolean") config.enabled = obj.enabled;
    else warn(filePath, "enabled must be a boolean", onProblem);
  }
  if (obj.data_dir !== undefined) {
    if (typeof obj.data_dir === "string") config.dataDir = obj.data_dir;
    else warn(filePath, "data_dir must be a string", onProblem);
  }
  if (obj.model_cache_dir !== undefined) {
    if (typeof obj.model_cache_dir === "string")
      config.modelCacheDir = obj.model_cache_dir;
    else warn(filePath, "model_cache_dir must be a string", onProblem);
  }
  if (obj.embed_dims !== undefined) {
    if (
      typeof obj.embed_dims === "number" &&
      Number.isFinite(obj.embed_dims) &&
      obj.embed_dims > 0
    ) {
      config.embedDims = obj.embed_dims;
    } else {
      warn(filePath, "embed_dims must be a positive number", onProblem);
    }
  }
  if (obj.heavy_mode !== undefined) {
    if (typeof obj.heavy_mode === "boolean") config.heavyMode = obj.heavy_mode;
    else warn(filePath, "heavy_mode must be a boolean", onProblem);
  }

  if (obj.exclude !== undefined) {
    if (
      Array.isArray(obj.exclude) &&
      obj.exclude.every((p) => typeof p === "string")
    ) {
      config.exclude = obj.exclude as string[];
    } else {
      warn(filePath, "exclude must be a list of strings", onProblem);
    }
  }
  if (obj.shared_worker !== undefined) {
    if (typeof obj.shared_worker === "boolean") config.sharedWorker = obj.shared_worker;
    else warn(filePath, "shared_worker must be a boolean", onProblem);
  }
  if (obj.reranker !== undefined) {
    if (typeof obj.reranker === "boolean") config.reranker = obj.reranker;
    else warn(filePath, "reranker must be a boolean", onProblem);
  }
  if (obj.file_summaries !== undefined) {
    if (typeof obj.file_summaries === "boolean") config.fileSummaries = obj.file_summaries;
    else warn(filePath, "file_summaries must be a boolean", onProblem);
  }
  if (obj.summary_llm === false) {
    config.summaryLlm = false;
  } else if (obj.summary_llm !== undefined) {
    const llm = obj.summary_llm as Record<string, unknown> | null;
    const isText = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
    if (llm && typeof llm === "object" && isText(llm.base_url) && isText(llm.model)) {
      config.summaryLlm = { baseUrl: llm.base_url.trim(), model: llm.model.trim() };
      if (isText(llm.api_key_env)) config.summaryLlm.apiKeyEnv = llm.api_key_env.trim();
      if (llm.api_key !== undefined)
        warn(
          filePath,
          "summary_llm.api_key is not supported (keys must not live in a committed file); put the key in an environment variable and name it with api_key_env",
          onProblem,
        );
      if (typeof llm.timeout_ms === "number" && Number.isInteger(llm.timeout_ms) && llm.timeout_ms > 0)
        config.summaryLlm.timeoutMs = llm.timeout_ms;
    } else {
      warn(filePath, "summary_llm needs non-empty base_url and model", onProblem);
    }
  }
  for (const [yamlKey, field] of [
    ["reindex_chunks", "reindexChunks"],
    ["reindex_summaries", "reindexSummaries"],
  ] as const) {
    if (obj[yamlKey] === undefined) continue;
    if (typeof obj[yamlKey] === "boolean") config[field] = obj[yamlKey];
    else warn(filePath, `${yamlKey} must be a boolean`, onProblem);
  }
  if (obj.agent_hint !== undefined) {
    if (typeof obj.agent_hint === "boolean") config.agentHint = obj.agent_hint;
    else warn(filePath, "agent_hint must be a boolean", onProblem);
  }
  for (const [yamlKey, field] of [
    ["tool_log", "toolLog"],
    ["tool_log_full_responses", "toolLogFullResponses"],
  ] as const) {
    if (obj[yamlKey] === undefined) continue;
    if (typeof obj[yamlKey] === "boolean") config[field] = obj[yamlKey];
    else warn(filePath, `${yamlKey} must be a boolean`, onProblem);
  }
  if (obj.otel_enabled !== undefined) {
    if (typeof obj.otel_enabled === "boolean") config.otelEnabled = obj.otel_enabled;
    else warn(filePath, "otel_enabled must be a boolean", onProblem);
  }
  for (const [yamlKey, field] of [
    ["otel_endpoint", "otelEndpoint"],
    ["project", "project"],
  ] as const) {
    if (obj[yamlKey] === undefined) continue;
    if (typeof obj[yamlKey] === "string" && (obj[yamlKey] as string).trim()) config[field] = obj[yamlKey] as string;
    else warn(filePath, `${yamlKey} must be a non-empty string`, onProblem);
  }
  if (obj.otel_flush_ms !== undefined) {
    if (typeof obj.otel_flush_ms === "number" && Number.isInteger(obj.otel_flush_ms) && obj.otel_flush_ms > 0)
      config.otelFlushMs = obj.otel_flush_ms;
    else warn(filePath, "otel_flush_ms must be a positive integer", onProblem);
  }
  if (obj.install_skills !== undefined) {
    if (typeof obj.install_skills === "boolean")
      config.installSkills = obj.install_skills;
    else warn(filePath, "install_skills must be a boolean", onProblem);
  }
  if (obj.os_notifications !== undefined) {
    if (typeof obj.os_notifications === "boolean")
      config.osNotifications = obj.os_notifications;
    else warn(filePath, "os_notifications must be a boolean", onProblem);
  }

  const limits = [
    ["max_memory_mb", "maxMemoryMb"],
    ["embed_threads", "embedThreads"],
    ["embed_concurrency", "embedConcurrency"],
    ["embed_max_tokens", "embedMaxTokens"],
    ["max_file_bytes", "maxFileBytes"],
  ] as const;
  for (const [yamlKey, field] of limits) {
    const value = obj[yamlKey];
    if (value === undefined) continue;
    if (typeof value === "number" && Number.isInteger(value) && value > 0)
      config[field] = value;
    else warn(filePath, `${yamlKey} must be a positive integer`, onProblem);
  }

  return config;
}
