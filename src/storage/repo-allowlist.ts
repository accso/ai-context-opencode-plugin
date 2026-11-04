import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml, parseDocument } from "yaml";
import { resolveConfigFilePath } from "../config/config-file.js";
import { projectName } from "./project-key.js";

/**
 * Cross-repo search allow-list (plan.md, "cross-repo-allowlist",
 * user-directed 2026-09-15): lets a repo opt into also searching one
 * or more OTHER repos' vector stores via `semantic_search` -- e.g. a
 * library/dependency repo indexed on the same machine -- without
 * weakening `multi-repo-isolation`'s default-deny physical separation
 * for everyone else. The list lives INSIDE the worktree (so it's
 * versionable/shareable with the team, same reasoning as
 * `backup.ts`'s repo-local backup file), as the `allowed_repos` key of
 * `.opencode/ai-context.config.yaml`. The plugin edits that key in place
 * (comments and other keys stay) and reads it from disk on every call, so
 * changes apply without a restart. Older versions stored it in
 * `.opencode/ai-context/config/allowed-repos.json`; that file is imported
 * into the YAML once and removed.
 *
 * Entries are project **names** (`libfoo`), i.e. the project key without
 * its `-<hash8>` suffix: the hash depends on the clone path, so it
 * differs per user and must not be committed. Callers (see
 * `manage-allowlist.ts`) must validate a name actually exists in
 * `project-registry.ts`'s `listProjects()` before adding it here, so
 * this file never accumulates typos or repos that were never indexed.
 * Legacy entries that still carry the hash are normalized on read.
 */

function legacyFilePath(worktree: string): string {
  return path.join(worktree, ".opencode", "ai-context", "config", "allowed-repos.json");
}

export interface AddAllowedRepoResult {
  added: boolean;
  keys: string[];
}

function normalize(entries: unknown): string[] {
  if (!Array.isArray(entries)) return [];
  return [
    ...new Set(
      entries.filter((e): e is string => typeof e === "string" && e.trim() !== "").map((e) => projectName(e.trim())),
    ),
  ].sort();
}

function readFromYaml(worktree: string): string[] {
  const filePath = resolveConfigFilePath(worktree);
  if (!fs.existsSync(filePath)) return [];
  try {
    const parsed = parseYaml(fs.readFileSync(filePath, "utf8")) as Record<string, unknown> | null;
    return normalize(parsed?.allowed_repos);
  } catch {
    return [];
  }
}

function writeToYaml(worktree: string, keys: string[]): void {
  const filePath = resolveConfigFilePath(worktree);
  const exists = fs.existsSync(filePath);
  const doc = parseDocument(exists ? fs.readFileSync(filePath, "utf8") : "");
  if (doc.errors.length > 0) {
    throw new Error(`cannot update allowed_repos: ${filePath} is not valid YAML (${doc.errors[0]!.message})`);
  }
  if (!doc.contents) doc.contents = doc.createNode({}) as unknown as typeof doc.contents;
  if (!doc.has("allowed_repos")) {
    const key = doc.createNode("allowed_repos");
    key.commentBefore = ALLOWED_REPOS_COMMENT;
    doc.set(key, keys);
  } else {
    doc.set("allowed_repos", keys);
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, doc.toString());
}

const ALLOWED_REPOS_COMMENT =
  " Other indexed projects (names, no hash) that semantic_search and the project argument\n" +
  " may also look into. Written by the plugin (ai_context_allow_repo); manual edits are fine.";

/** Imports the legacy JSON allowlist into the YAML once and removes the old file. */
function migrateLegacy(worktree: string): void {
  const legacy = legacyFilePath(worktree);
  if (!fs.existsSync(legacy)) return;
  try {
    const old = normalize(JSON.parse(fs.readFileSync(legacy, "utf8")));
    const merged = normalize([...readFromYaml(worktree), ...old]);
    if (merged.length > 0) writeToYaml(worktree, merged);
    fs.rmSync(legacy);
    const dir = path.dirname(legacy);
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch {
    // keep the legacy file; retried on the next call
  }
}

export function readAllowlist(worktree: string): string[] {
  migrateLegacy(worktree);
  return readFromYaml(worktree);
}

/** Adds the project `name` to the allow-list, sorted and deduplicated. */
export function addAllowedRepo(worktree: string, name: string): AddAllowedRepoResult {
  const existing = readAllowlist(worktree);
  if (existing.includes(name)) {
    return { added: false, keys: existing };
  }
  const keys = [...existing, name].sort();
  writeToYaml(worktree, keys);
  return { added: true, keys };
}
