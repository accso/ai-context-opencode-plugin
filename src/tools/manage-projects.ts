import { tool } from "./tool-def.js";
import type { ProjectInfo } from "../storage/project-registry.js";

/**
 * Native tools for managing per-project data on disk (user-directed,
 * 2026-09-14): each session's project gets its own SQLite file
 * (`project-key.ts`/`vector-store.ts`), but nothing else in this plugin
 * ever removes one -- the data dir would only grow as repos are cloned,
 * moved, or retired. These give the agent/user a way to see what's
 * stored and reclaim it, without a separate CLI/script.
 */

export interface ProjectRegistryDeps {
  listProjects: () => ProjectInfo[];
  deleteProject: (key: string) => boolean;
}

export function createListProjectsTool(
  registry: Pick<ProjectRegistryDeps, "listProjects">,
) {
  return tool({
    description: [
      "Use when the user asks which repos/projects are indexed or how much",
      "disk the indexes use. Lists every project this plugin currently has",
      "indexed data for on this machine (name, key, vector-store file",
      "path, size on disk). Use the `name` (no hash) as `project` argument",
      "of the search tools.",
      "Use this before ai_context_delete_project to find the key of a",
      "project (e.g. an old clone or a repo that's no longer in use) you",
      "want to remove.",
    ].join(" "),
    args: {},
    async execute() {
      return JSON.stringify(registry.listProjects());
    },
  });
}

export function createDeleteProjectTool(
  registry: Pick<ProjectRegistryDeps, "deleteProject">,
) {
  return tool({
    description: [
      "Delete a project's indexed data (its entire vector-store directory)",
      "from disk. Destructive: confirm with the user which project to delete",
      "before calling. Use ai_context_list_projects first to find the exact",
      "key. This does not touch the project's actual source repository --",
      "only this plugin's own index for it -- and is safe to call for a",
      "project that no longer exists on disk (returns deleted: false).",
    ].join(" "),
    args: {
      key: tool.schema
        .string()
        .describe(
          "The project's key, as returned by ai_context_list_projects.",
        ),
    },
    async execute(args) {
      const deleted = registry.deleteProject(args.key);
      return JSON.stringify({ deleted, key: args.key });
    },
  });
}
