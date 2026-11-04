import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installBundledSkills, resolveProjectSkillsDir } from "../../src/skills/skill-installer.js";
import { CROSS_REPO_SKILL_MD } from "../../src/skills/cross-repo-skill.js";
import { INDEX_STATUS_SKILL_MD, INDEX_STATUS_WATCH_SCRIPT, SKILL_MANAGED_MARKER } from "../../src/skills/index-status-skill.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ai-context-skills-"));
const skillFile = (dir: string) => path.join(resolveProjectSkillsDir(dir), "index-status", "SKILL.md");
const scriptFile = (dir: string) => path.join(resolveProjectSkillsDir(dir), "index-status", "scripts", "watch-index-status.sh");

test("the skill is valid for opencode: name matches directory, description present, marker after frontmatter", () => {
  assert.match(INDEX_STATUS_SKILL_MD, /^---\nname: index-status\ndescription: /);
  assert.ok(INDEX_STATUS_SKILL_MD.includes(SKILL_MANAGED_MARKER));
});

test("installs SKILL.md and an executable script when missing", () => {
  const dir = tmp();
  assert.deepEqual(installBundledSkills(dir), { installed: ["index-status", "cross-repo"], problems: [] });
  assert.equal(fs.readFileSync(skillFile(dir), "utf8"), INDEX_STATUS_SKILL_MD);
  assert.ok(fs.statSync(scriptFile(dir)).mode & 0o100);
});

test("is idempotent and updates an outdated managed copy", () => {
  const dir = tmp();
  installBundledSkills(dir);
  assert.deepEqual(installBundledSkills(dir).installed, []);
  fs.writeFileSync(skillFile(dir), `---\nname: index-status\n---\n${SKILL_MANAGED_MARKER}\nold`);
  assert.deepEqual(installBundledSkills(dir).installed, ["index-status"]);
  assert.equal(fs.readFileSync(skillFile(dir), "utf8"), INDEX_STATUS_SKILL_MD);
});

test("never touches a skill the user took over (no marker)", () => {
  const dir = tmp();
  fs.mkdirSync(path.dirname(skillFile(dir)), { recursive: true });
  fs.writeFileSync(skillFile(dir), "my own skill");
  assert.deepEqual(installBundledSkills(dir), { installed: ["cross-repo"], problems: [] });
  assert.equal(fs.readFileSync(skillFile(dir), "utf8"), "my own skill");
});

test("write errors are returned as problems, never thrown", () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, ".opencode"));
  fs.writeFileSync(path.join(dir, ".opencode", "skills"), "a file where the directory should be");
  const result = installBundledSkills(dir);
  assert.equal(result.installed.length, 0);
  assert.equal(result.problems.length, 2);
});

test("skills live in <worktree>/.opencode/skills, not globally", () => {
  assert.equal(resolveProjectSkillsDir("/repo"), "/repo/.opencode/skills");
});

test("the skill has the agent read the status once and hand the watch command to the user, never run the watcher", () => {
  assert.match(INDEX_STATUS_SKILL_MD, /NEVER run `watch-index-status\.sh` yourself/);
  assert.match(INDEX_STATUS_SKILL_MD, /read the JSON file once/i);
  assert.match(INDEX_STATUS_SKILL_MD, /(^|\n)<worktree>\/\.opencode\/skills\/index-status\/scripts\/watch-index-status\.sh/);
  assert.doesNotMatch(INDEX_STATUS_SKILL_MD, /idea_execute_terminal_command/);
});

test("the watch script finds the worktree from its own location, from any cwd", async () => {
  const { spawnSync } = await import("node:child_process");
  const os = await import("node:os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-watch-"));
  installBundledSkills(dir);
  fs.mkdirSync(path.join(dir, ".opencode", "ai-context"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".opencode", "ai-context", "index-status.json"), '{"phase":"indexing"}');
  const script = path.join(dir, ".opencode", "skills", "index-status", "scripts", "watch-index-status.sh");
  const run = (args: string[], cwd: string) =>
    spawnSync("bash", [script, ...args], { cwd, env: { ...process.env, AI_CONTEXT_WATCH_ONCE: "1" }, encoding: "utf8" }).stdout;
  assert.match(run([], path.dirname(script)), /indexing/);
  assert.match(run([], os.tmpdir()), /indexing/);
  assert.match(run([dir], os.tmpdir()), /indexing/);
});

test("cross-repo skill is installed, managed, and names the tool sequence", () => {
  const dir = tmp();
  installBundledSkills(dir);
  const file = path.join(resolveProjectSkillsDir(dir), "cross-repo", "SKILL.md");
  assert.equal(fs.readFileSync(file, "utf8"), CROSS_REPO_SKILL_MD);
  assert.match(CROSS_REPO_SKILL_MD, /^---\nname: cross-repo\ndescription: /);
  assert.ok(CROSS_REPO_SKILL_MD.includes(SKILL_MANAGED_MARKER));
  for (const t of ["ai_context_list_projects", "ai_context_allow_repo", "semantic_search", "find_symbol", "repo_structure"])
    assert.ok(CROSS_REPO_SKILL_MD.includes(t), t);
});

test("the bundled watch script is identical to the one committed under .opencode/skills", async () => {
  const { INDEX_STATUS_WATCH_SCRIPT } = await import("../../src/skills/index-status-skill.js");
  const onDisk = fs.readFileSync(
    path.join(process.cwd(), ".opencode", "skills", "index-status", "scripts", "watch-index-status.sh"),
    "utf8",
  );
  assert.equal(INDEX_STATUS_WATCH_SCRIPT, onDisk);
});

test("refreshes a copy that still carries the pre-rename marker", () => {
  const dir = tmp();
  installBundledSkills(dir);
  fs.writeFileSync(skillFile(dir), "---\nname: index-status\n---\n<!-- managed-by: opencode-ai-context-plugin -->\nold");
  assert.deepEqual(installBundledSkills(dir).installed, ["index-status"]);
  assert.equal(fs.readFileSync(skillFile(dir), "utf8"), INDEX_STATUS_SKILL_MD);
});
