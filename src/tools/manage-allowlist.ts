import { tool } from "./tool-def.js";
import type { ProjectInfo } from "../storage/project-registry.js";
import { addAllowedRepo as addAllowedRepoDefault } from "../storage/repo-allowlist.js";

/**
 * Native tool letting the agent grow this repo's cross-repo search
 * allow-list (plan.md, "cross-repo-allowlist", user-directed
 * 2026-09-15): "softens the walls" `multi-repo-isolation` put up by
 * default, for repos the user explicitly wants included (e.g. a
 * library/dependency also indexed on this machine).
 *
 * `repoName` MUST be the stable name of an existing project (the key
 * without its per-machine hash, see `ai_context_list_projects`). The tool
 * validates against the real registry (defense in depth against a stale
 * or guessed name); the hashed key is not accepted, since the allow-list
 * is shared via the repo and the hash differs per user.
 */

export interface AllowRepoDeps {
  worktree: string;
  listProjects(): ProjectInfo[];
  /** Injectable for tests; defaults to the real repo-allowlist.ts implementation. */
  addAllowedRepo?: (
    worktree: string,
    name: string,
  ) => { added: boolean; keys: string[] };
}

export function createAllowRepoTool(deps: AllowRepoDeps) {
  const addAllowedRepo = deps.addAllowedRepo ?? addAllowedRepoDefault;
  return tool({
    description: [
      "Allow this repository's semantic_search to also search another",
      "already-indexed repo (e.g. a library/dependency) -- softens the",
      "default per-repo isolation for repos the user explicitly opts in.",
      "repoName must be an exact project name: call ai_context_list_projects",
      "first to find the right name for the repo the user described, then",
      "pass that name here. Only call this when the user actually asks to",
      "see another repo's results.",
    ].join(" "),
    args: {
      repoName: tool.schema
        .string()
        .describe(
          "Exact project name from ai_context_list_projects (field `name`, without hash) for the repo to allow.",
        ),
    },
    async execute(args) {
      const known = deps.listProjects();
      if (!known.some((project) => project.name === args.repoName)) {
        const validNames =
          [...new Set(known.map((project) => project.name))].join(", ") ||
          "(none indexed yet)";
        throw new Error(
          `Unknown project name ${JSON.stringify(args.repoName)}. Call ai_context_list_projects to see valid names: ${validNames}`,
        );
      }
      const result = addAllowedRepo(deps.worktree, args.repoName);
      return JSON.stringify(result);
    },
  });
}
