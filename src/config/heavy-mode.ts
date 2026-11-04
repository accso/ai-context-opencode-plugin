/**
 * "Heavy mode" opt-in flag (plan.md, "slim-analyze-impact-drop-lspbridge",
 * "analyze-impact-honest-stub").
 *
 * NOTE: this flag currently has NO functional effect. It originally
 * gated `analyze_impact`, which is now always registered and backed by the
 * precomputed graph (ADR-0006). The flag is kept as infrastructure for any
 * future heavy-mode-only feature (e.g. a large-monorepo cutover to a
 * heavier storage backend) so that work doesn't re-invent the env-var
 * plumbing.
 *
 * Settable via `AI_CONTEXT_PLUGIN_HEAVY_MODE` OR a repo's
 * `.opencode/ai-context.config.yaml` (`heavy_mode`, config-file.ts,
 * user-directed 2026-09-16) -- an explicitly-set env var always wins
 * over the config file, so a single machine can still opt in/out
 * regardless of what the repo's committed config says.
 */
export function isHeavyModeEnabled(
  env: Record<string, string | undefined> = process.env,
  heavyModeFromConfigFile?: boolean,
): boolean {
  const raw = env.AI_CONTEXT_PLUGIN_HEAVY_MODE;
  if (raw !== undefined) {
    return raw.toLowerCase() === "1" || raw.toLowerCase() === "true";
  }
  return heavyModeFromConfigFile === true;
}
