import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SUMMARY_LLM, loadConfigFile, resolveConfigFilePath } from "../../src/config/config-file.js";

/**
 * Unit tests for the project-level YAML config file (user-directed,
 * 2026-09-16): ".opencode/ai-context.config.yaml" -- a single,
 * team-committable place to set every AI_CONTEXT_PLUGIN_* knob that
 * previously only had an env-var interface (data_dir, model_cache_dir,
 * embed_dims, heavy_mode). Precedence is env var > config file > built-in
 * default (user-directed: "env vars become overrides on top of the
 * file") -- verified at each consuming module's own resolve* function
 * (heavy-mode.test.ts, model-runtime.test.ts, project-key.test.ts), not
 * here. This file only covers reading/parsing/validating the YAML file
 * itself, via injectable fs seams (no real disk I/O in unit tests).
 */

function fakeFs(files: Record<string, string>) {
  return {
    existsSync: (filePath: string) => filePath in files,
    readFileSync: (filePath: string) => files[filePath]!,
  };
}

test("resolveConfigFilePath points at .opencode/ai-context.config.yaml inside the worktree", () => {
  const filePath = resolveConfigFilePath("/repo/project");
  assert.equal(filePath, "/repo/project/.opencode/ai-context.config.yaml");
});

test("loadConfigFile returns an empty config when no file exists", () => {
  const config = loadConfigFile("/repo/project", fakeFs({}));
  assert.deepEqual(config, {});
});

test("loadConfigFile returns an empty config for an empty file", () => {
  const config = loadConfigFile(
    "/repo/project",
    fakeFs({ "/repo/project/.opencode/ai-context.config.yaml": "" }),
  );
  assert.deepEqual(config, {});
});

test("loadConfigFile parses every known setting from snake_case YAML keys", () => {
  const yaml = [
    "data_dir: /custom/data-dir",
    "model_cache_dir: /custom/model-cache",
    "embed_dims: 256",
    "heavy_mode: true",
  ].join("\n");
  const config = loadConfigFile(
    "/repo/project",
    fakeFs({ "/repo/project/.opencode/ai-context.config.yaml": yaml }),
  );
  assert.deepEqual(config, {
    dataDir: "/custom/data-dir",
    modelCacheDir: "/custom/model-cache",
    embedDims: 256,
    heavyMode: true,
  });
});

test("loadConfigFile ignores unknown keys instead of throwing", () => {
  const yaml = ["data_dir: /custom/data-dir", "some_future_setting: 42"].join("\n");
  const config = loadConfigFile(
    "/repo/project",
    fakeFs({ "/repo/project/.opencode/ai-context.config.yaml": yaml }),
  );
  assert.deepEqual(config, { dataDir: "/custom/data-dir" });
});

test("loadConfigFile ignores wrong-typed values for a known key instead of throwing", () => {
  const yaml = ["data_dir: /custom/data-dir", "embed_dims: not-a-number"].join("\n");
  const config = loadConfigFile(
    "/repo/project",
    fakeFs({ "/repo/project/.opencode/ai-context.config.yaml": yaml }),
  );
  assert.deepEqual(config, { dataDir: "/custom/data-dir" });
});

test("loadConfigFile ignores a non-positive embed_dims value instead of throwing", () => {
  const yaml = "embed_dims: -5";
  const config = loadConfigFile(
    "/repo/project",
    fakeFs({ "/repo/project/.opencode/ai-context.config.yaml": yaml }),
  );
  assert.deepEqual(config, {});
});

test("loadConfigFile returns an empty config (not a crash) for malformed YAML", () => {
  const yaml = "data_dir: [unterminated";
  const config = loadConfigFile(
    "/repo/project",
    fakeFs({ "/repo/project/.opencode/ai-context.config.yaml": yaml }),
  );
  assert.deepEqual(config, {});
});

test("loadConfigFile returns an empty config (not a crash) when the top level isn't a mapping", () => {
  const yaml = "- just\n- a\n- list";
  const config = loadConfigFile(
    "/repo/project",
    fakeFs({ "/repo/project/.opencode/ai-context.config.yaml": yaml }),
  );
  assert.deepEqual(config, {});
});

const CONFIG_PATH = "/repo/project/.opencode/ai-context.config.yaml";

test("loadConfigFile parses the resource-limit settings", () => {
  const yaml = ["max_memory_mb: 2048", "embed_threads: 3", "embed_max_tokens: 256", "max_file_bytes: 200000"].join("\n");
  assert.deepEqual(loadConfigFile("/repo/project", fakeFs({ [CONFIG_PATH]: yaml })), {
    maxMemoryMb: 2048,
    embedThreads: 3,
    embedMaxTokens: 256,
    maxFileBytes: 200000,
  });
});

test("loadConfigFile ignores resource limits that are not positive integers", () => {
  const originalError = console.error;
  console.error = () => {};
  try {
    for (const bad of ["0", "-5", "1.5", "lots", "true"]) {
      for (const key of ["max_memory_mb", "embed_threads", "embed_max_tokens", "max_file_bytes"]) {
        assert.deepEqual(loadConfigFile("/repo/project", fakeFs({ [CONFIG_PATH]: `${key}: ${bad}` })), {}, `${key}: ${bad}`);
      }
    }
  } finally {
    console.error = originalError;
  }
});

test("loadConfigFile parses os_notifications as a boolean and rejects other types", () => {
  assert.deepEqual(loadConfigFile("/repo/project", fakeFs({ [CONFIG_PATH]: "os_notifications: false" })), {
    osNotifications: false,
  });
  const originalError = console.error;
  console.error = () => {};
  try {
    assert.deepEqual(loadConfigFile("/repo/project", fakeFs({ [CONFIG_PATH]: "os_notifications: nope" })), {});
  } finally {
    console.error = originalError;
  }
});

test("loadConfigFile parses exclude as a list of patterns and rejects non-lists", () => {
  const yaml = "exclude:\n  - legacy/\n  - '**/*.generated.ts'";
  assert.deepEqual(loadConfigFile("/repo/project", fakeFs({ [CONFIG_PATH]: yaml })), {
    exclude: ["legacy/", "**/*.generated.ts"],
  });
  const originalError = console.error;
  console.error = () => {};
  try {
    for (const bad of ["exclude: legacy/", "exclude: [1, 2]"]) {
      assert.deepEqual(loadConfigFile("/repo/project", fakeFs({ [CONFIG_PATH]: bad })), {}, bad);
    }
  } finally {
    console.error = originalError;
  }
});

test("loadConfigFile reports every problem through onProblem", () => {
  const problems: string[] = [];
  const originalError = console.error;
  console.error = () => {};
  try {
    loadConfigFile("/repo/project", fakeFs({ [CONFIG_PATH]: "embed_threads: 0" }), (m) => void problems.push(m));
    loadConfigFile("/repo/project", fakeFs({ [CONFIG_PATH]: "a: [unclosed" }), (m) => void problems.push(m));
  } finally {
    console.error = originalError;
  }
  assert.equal(problems.length, 2);
  assert.match(problems[0]!, /embed_threads/);
  assert.match(problems[1]!, /malformed YAML/);
});

test("loadConfigFile parses install_skills as a boolean", () => {
  assert.deepEqual(loadConfigFile("/repo/project", fakeFs({ [CONFIG_PATH]: "install_skills: false" })), {
    installSkills: false,
  });
});

test("loadConfigFile parses agent_hint as a boolean", () => {
  assert.deepEqual(loadConfigFile("/repo/project", fakeFs({ [CONFIG_PATH]: "agent_hint: false" })), {
    agentHint: false,
  });
});

test("loadConfigFile parses shared_worker as a boolean", () => {
  assert.deepEqual(loadConfigFile("/repo/project", fakeFs({ [CONFIG_PATH]: "shared_worker: false" })), {
    sharedWorker: false,
  });
});

test("loadConfigFile parses reranker as a boolean", () => {
  assert.deepEqual(loadConfigFile("/repo/project", fakeFs({ [CONFIG_PATH]: "reranker: false" })), {
    reranker: false,
  });
});

const CFG = resolveConfigFilePath("/r");

test("loadConfigFile reads the summary_llm block and file_summaries", () => {
  const yaml = [
    "file_summaries: false",
    "summary_llm:",
    "  base_url: http://localhost:1234/v1",
    "  model: qwen2.5-coder-7b-instruct",
    "  api_key_env: LM_KEY",
    "  timeout_ms: 20000",
  ].join("\n");
  const config = loadConfigFile("/r", fakeFs({ [CFG]: yaml }));
  assert.equal(config.fileSummaries, false);
  assert.deepEqual(config.summaryLlm, {
    baseUrl: "http://localhost:1234/v1",
    model: "qwen2.5-coder-7b-instruct",
    apiKeyEnv: "LM_KEY",
    timeoutMs: 20000,
  });
});

test("loadConfigFile ignores a summary_llm block without base_url and model", () => {
  const problems: string[] = [];
  const config = loadConfigFile("/r", fakeFs({ [CFG]: "summary_llm:\n  model: m\n" }), (m) => problems.push(m));
  assert.equal(config.summaryLlm, undefined);
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /summary_llm/);
});

test("DEFAULT_SUMMARY_LLM points at the local oMLX server", () => {
  assert.deepEqual(DEFAULT_SUMMARY_LLM, {
    baseUrl: "http://127.0.0.1:8000/v1",
    model: "Qwen2.5-Coder-3B-Instruct-MLX-4bit",
    apiKeyEnv: "AI_CONTEXT_SUMMARY_LLM_API_KEY",
  });
});

test("summary_llm: false disables the LLM", () => {
  assert.equal(loadConfigFile("/r", fakeFs({ [CFG]: "summary_llm: false\n" })).summaryLlm, false);
});

test("a literal api_key in summary_llm is ignored with a hint to use api_key_env", () => {
  const problems: string[] = [];
  const originalError = console.error;
  console.error = () => {};
  try {
    const config = loadConfigFile(
      "/r",
      fakeFs({ [CFG]: "summary_llm:\n  base_url: http://h/v1\n  model: m\n  api_key: k\n" }),
      (m) => problems.push(m),
    );
    assert.deepEqual(config.summaryLlm, { baseUrl: "http://h/v1", model: "m" });
  } finally {
    console.error = originalError;
  }
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /api_key_env/);
  assert.doesNotMatch(problems[0]!, /\bk\b/);
});

test("loadConfigFile parses reindex_chunks and reindex_summaries as booleans and rejects other types", () => {
  assert.deepEqual(
    loadConfigFile("/repo/project", fakeFs({ [CONFIG_PATH]: "reindex_chunks: true\nreindex_summaries: false" })),
    { reindexChunks: true, reindexSummaries: false },
  );
  const originalError = console.error;
  console.error = () => {};
  try {
    assert.deepEqual(loadConfigFile("/repo/project", fakeFs({ [CONFIG_PATH]: "reindex_chunks: yes please" })), {});
  } finally {
    console.error = originalError;
  }
});

test("loadConfigFile parses enabled as a boolean and rejects other types", () => {
  assert.deepEqual(loadConfigFile("/repo/project", fakeFs({ [CONFIG_PATH]: "enabled: true" })), { enabled: true });
  assert.deepEqual(loadConfigFile("/repo/project", fakeFs({ [CONFIG_PATH]: "enabled: false" })), { enabled: false });
  const originalError = console.error;
  console.error = () => {};
  try {
    assert.deepEqual(loadConfigFile("/repo/project", fakeFs({ [CONFIG_PATH]: "enabled: sure" })), {});
  } finally {
    console.error = originalError;
  }
});

test("loadConfigFile parses tool_log and tool_log_full_responses as booleans", () => {
  assert.deepEqual(
    loadConfigFile("/repo/project", fakeFs({ [CONFIG_PATH]: "tool_log: true\ntool_log_full_responses: true" })),
    { toolLog: true, toolLogFullResponses: true },
  );
});

test("loadConfigFile warns about an invalid tool_log or tool_log_full_responses", () => {
  const messages: string[] = [];
  const config = loadConfigFile(
    "/repo/project",
    fakeFs({ [CONFIG_PATH]: "tool_log: yes please\ntool_log_full_responses: everything" }),
    (m) => messages.push(m),
  );
  assert.deepEqual(config, {});
  assert.equal(messages.length, 2);
});
