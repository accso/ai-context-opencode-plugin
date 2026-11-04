import { test } from "node:test";
import assert from "node:assert/strict";
import { isHeavyModeEnabled } from "../../src/config/heavy-mode.js";

/**
 * Unit tests for the "heavy mode" opt-in flag (plan.md,
 * "slim-analyze-impact-drop-lspbridge"): `analyze_impact` is a
 * precomputed, repo-wide call/import graph -- only worth the
 * precomputation cost on large monorepos where OpenCode's built-in
 * `lsp` tool's on-demand `incomingCalls`/`outgoingCalls` would be
 * issued too many times. Default-off; settable via the
 * `AI_CONTEXT_PLUGIN_HEAVY_MODE` env var OR a repo's
 * `.opencode/ai-context.config.yaml` (`heavy_mode`, config-file.ts,
 * user-directed 2026-09-16) -- the env var wins when explicitly set,
 * so a single machine can still override a team's committed default.
 */

test("isHeavyModeEnabled is false by default (no env var set)", () => {
  assert.equal(isHeavyModeEnabled({}), false);
});

test("isHeavyModeEnabled is true when AI_CONTEXT_PLUGIN_HEAVY_MODE=1", () => {
  assert.equal(isHeavyModeEnabled({ AI_CONTEXT_PLUGIN_HEAVY_MODE: "1" }), true);
});

test("isHeavyModeEnabled is true when AI_CONTEXT_PLUGIN_HEAVY_MODE=true (case-insensitive)", () => {
  assert.equal(isHeavyModeEnabled({ AI_CONTEXT_PLUGIN_HEAVY_MODE: "TRUE" }), true);
});

test("isHeavyModeEnabled is false for any other value", () => {
  assert.equal(isHeavyModeEnabled({ AI_CONTEXT_PLUGIN_HEAVY_MODE: "0" }), false);
  assert.equal(isHeavyModeEnabled({ AI_CONTEXT_PLUGIN_HEAVY_MODE: "false" }), false);
  assert.equal(isHeavyModeEnabled({ AI_CONTEXT_PLUGIN_HEAVY_MODE: "" }), false);
});

/**
 * Config-file fallback (user-directed, 2026-09-16): heavy_mode is now
 * also settable via `.opencode/ai-context.config.yaml` (config-file.ts),
 * for a team that wants it on by default for a given repo -- superseding
 * this file's earlier "machine/session-level, not a per-repo team
 * setting" reasoning now that a per-repo config file actually exists.
 * The env var still wins when explicitly set, so a single machine can
 * still opt out/in regardless of what the repo's committed config says.
 */

test("isHeavyModeEnabled falls back to the config-file value when no env var is set", () => {
  assert.equal(isHeavyModeEnabled({}, true), true);
  assert.equal(isHeavyModeEnabled({}, false), false);
  assert.equal(isHeavyModeEnabled({}, undefined), false);
});

test("isHeavyModeEnabled prefers an explicitly-set env var over the config-file value", () => {
  assert.equal(isHeavyModeEnabled({ AI_CONTEXT_PLUGIN_HEAVY_MODE: "false" }, true), false);
  assert.equal(isHeavyModeEnabled({ AI_CONTEXT_PLUGIN_HEAVY_MODE: "true" }, false), true);
});
