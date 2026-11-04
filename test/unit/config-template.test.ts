import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CONFIG_TEMPLATE, ensureConfigFile, resetReindexFlags } from "../../src/config/config-template.js";
import { DEFAULT_SUMMARY_LLM, loadConfigFile, resolveConfigFilePath } from "../../src/config/config-file.js";
import { DEFAULT_EMBED_THREADS } from "../../src/embedding/model-runtime.js";
import { DEFAULT_MAX_EMBED_TOKENS } from "../../src/embedding/embedder.js";
import { DEFAULT_MAX_FILE_BYTES } from "../../src/indexing/indexing.js";
import { DEFAULT_EMBED_CONCURRENCY, DEFAULT_MAX_MEMORY_MB } from "../../src/hook/plugin.js";

const KEYS = ["enabled", "data_dir", "model_cache_dir", "embed_dims", "heavy_mode", "max_memory_mb", "embed_threads", "embed_concurrency", "embed_max_tokens", "max_file_bytes", "exclude", "os_notifications", "install_skills", "agent_hint", "tool_log", "tool_log_full_responses", "shared_worker", "reranker", "file_summaries", "summary_llm", "reindex_chunks", "reindex_summaries"];

function loadTemplate() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-context-template-"));
  fs.mkdirSync(path.join(dir, ".opencode"));
  fs.writeFileSync(resolveConfigFilePath(dir), CONFIG_TEMPLATE);
  return loadConfigFile(dir);
}

test("the template documents every config key", () => {
  for (const key of KEYS) assert.match(CONFIG_TEMPLATE, new RegExp(`^(# )?${key}:`, "m"), key);
});

test("the template names the environment variable of every key that has one", () => {
  for (const env of [
    "AI_CONTEXT_PLUGIN_ENABLED",
    "AI_CONTEXT_PLUGIN_DATA_DIR",
    "AI_CONTEXT_PLUGIN_MODEL_CACHE_DIR",
    "AI_CONTEXT_PLUGIN_EMBED_DIMS",
    "AI_CONTEXT_PLUGIN_HEAVY_MODE",
    "AI_CONTEXT_OS_NOTIFICATIONS",
    "AI_CONTEXT_INSTALL_SKILLS",
    "AI_CONTEXT_SHARED_WORKER",
    "AI_CONTEXT_SUMMARY_LLM_API_KEY",
  ]) assert.ok(CONFIG_TEMPLATE.includes(env), env);
});

test("the template never holds a literal API key", () => {
  assert.doesNotMatch(CONFIG_TEMPLATE, /^\s*api_key\s*:/m);
});

test("the template starts with `enabled: false` as its first active line", () => {
  const first = CONFIG_TEMPLATE.split("\n").find((l) => l.trim() !== "" && !l.startsWith("#"));
  assert.equal(first, "enabled: false");
});

test("the template's active values are exactly the built-in defaults", () => {
  assert.deepEqual(loadTemplate(), {
    enabled: false,
    maxMemoryMb: DEFAULT_MAX_MEMORY_MB,
    embedThreads: DEFAULT_EMBED_THREADS,
    embedConcurrency: DEFAULT_EMBED_CONCURRENCY,
    embedMaxTokens: DEFAULT_MAX_EMBED_TOKENS,
    maxFileBytes: DEFAULT_MAX_FILE_BYTES,
    osNotifications: true,
    agentHint: true,
    toolLog: false,
    toolLogFullResponses: false,
    reranker: true,
    fileSummaries: true,
    summaryLlm: DEFAULT_SUMMARY_LLM,
    sharedWorker: true,
    installSkills: true,
    reindexChunks: false,
    reindexSummaries: false,
  });
});

test("ensureConfigFile creates the file (and .opencode/) when missing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-context-template-"));
  assert.equal(ensureConfigFile(dir), true);
  assert.equal(fs.readFileSync(resolveConfigFilePath(dir), "utf8"), CONFIG_TEMPLATE);
});

test("ensureConfigFile never overwrites an existing file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-context-template-"));
  fs.mkdirSync(path.join(dir, ".opencode"));
  fs.writeFileSync(resolveConfigFilePath(dir), "heavy_mode: true\n");
  assert.equal(ensureConfigFile(dir), false);
  assert.equal(fs.readFileSync(resolveConfigFilePath(dir), "utf8"), "heavy_mode: true\n");
});

test("ensureConfigFile does nothing for a missing worktree and swallows write errors", () => {
  assert.equal(ensureConfigFile("/definitely/not/here"), false);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-context-template-"));
  fs.writeFileSync(path.join(dir, ".opencode"), "i am a file, not a dir");
  assert.equal(ensureConfigFile(dir), false);
});

test("ensureConfigFile hands write errors to onError instead of staying silent", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-context-template-"));
  fs.writeFileSync(path.join(dir, ".opencode"), "file");
  const errors: unknown[] = [];
  assert.equal(ensureConfigFile(dir, (e) => void errors.push(e)), false);
  assert.equal(errors.length, 1);
});

test("resetReindexFlags switches only active true flags to false and keeps everything else", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-context-template-"));
  fs.mkdirSync(path.join(dir, ".opencode"));
  const file = resolveConfigFilePath(dir);
  fs.writeFileSync(file, "# comment\nreindex_chunks: true   # once\nreindex_summaries: True\nheavy_mode: true\n# reindex_chunks: true\n");
  assert.equal(resetReindexFlags(dir), true);
  assert.equal(
    fs.readFileSync(file, "utf8"),
    "# comment\nreindex_chunks: false   # once\nreindex_summaries: false\nheavy_mode: true\n# reindex_chunks: true\n",
  );
  assert.deepEqual(loadConfigFile(dir), { heavyMode: true, reindexChunks: false, reindexSummaries: false });
});

test("resetReindexFlags leaves a file without active flags untouched and never throws", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-context-template-"));
  assert.equal(resetReindexFlags(dir), false);
  fs.mkdirSync(path.join(dir, ".opencode"));
  fs.writeFileSync(resolveConfigFilePath(dir), "heavy_mode: true\n");
  assert.equal(resetReindexFlags(dir), false);
  assert.equal(fs.readFileSync(resolveConfigFilePath(dir), "utf8"), "heavy_mode: true\n");
  const errors: unknown[] = [];
  fs.rmSync(path.join(dir, ".opencode"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".opencode"), "x");
  assert.equal(resetReindexFlags(dir, (e) => errors.push(e)), false);
});
