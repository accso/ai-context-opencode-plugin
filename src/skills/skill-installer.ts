import fs from "node:fs";
import path from "node:path";
import {
  INDEX_STATUS_SKILL_MD,
  INDEX_STATUS_WATCH_SCRIPT,
  SKILL_MANAGED_MARKER,
  LEGACY_SKILL_MANAGED_MARKER,
} from "./index-status-skill.js";
import { CROSS_REPO_SKILL_MD } from "./cross-repo-skill.js";

/**
 * The bundled skills are specific to this plugin, so they live in the project
 * (`<worktree>/.opencode/skills/<name>/`, which opencode discovers) and are
 * provided there by the plugin on start -- not globally.
 */
interface BundledSkill {
  name: string;
  files: { relativePath: string; content: string; executable?: boolean }[];
}

const BUNDLED_SKILLS: BundledSkill[] = [
  {
    name: "index-status",
    files: [
      { relativePath: "SKILL.md", content: INDEX_STATUS_SKILL_MD },
      {
        relativePath: "scripts/watch-index-status.sh",
        content: INDEX_STATUS_WATCH_SCRIPT,
        executable: true,
      },
    ],
  },
  {
    name: "cross-repo",
    files: [{ relativePath: "SKILL.md", content: CROSS_REPO_SKILL_MD }],
  },
];

export function resolveProjectSkillsDir(worktree: string): string {
  return path.join(worktree, ".opencode", "skills");
}

function readIfExists(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

export interface SkillInstallResult {
  installed: string[];
  problems: unknown[];
}

/**
 * Installs missing skills and refreshes copies that still carry the plugin's
 * marker. A SKILL.md without the marker is the user's and is left alone.
 */
export function installBundledSkills(worktree: string): SkillInstallResult {
  const skillsDir = resolveProjectSkillsDir(worktree);
  const result: SkillInstallResult = { installed: [], problems: [] };
  for (const skill of BUNDLED_SKILLS) {
    try {
      const target = path.join(skillsDir, skill.name);
      const existing = readIfExists(path.join(target, "SKILL.md"));
      if (
        existing !== null &&
        !existing.includes(SKILL_MANAGED_MARKER) &&
        !existing.includes(LEGACY_SKILL_MANAGED_MARKER)
      )
        continue;

      const upToDate = skill.files.every(
        (f) => readIfExists(path.join(target, f.relativePath)) === f.content,
      );
      if (upToDate) continue;

      for (const file of skill.files) {
        const filePath = path.join(target, file.relativePath);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, file.content);
        if (file.executable) fs.chmodSync(filePath, 0o755);
      }
      result.installed.push(skill.name);
    } catch (error) {
      result.problems.push(error);
    }
  }
  return result;
}
