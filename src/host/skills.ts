/**
 * Skills, as the app sees them.
 *
 * A skill is a directory holding `SKILL.md`; this module does not implement
 * skills — pi does — it only lists what pi would discover, so the app can show
 * them and open their folder. The only write here is an explicitly confirmed
 * delete, guarded to the roots listed below.
 *
 * Discovery mirrors pi's documented locations, in pi's precedence order:
 *   <workspace>/.pi/skills, <workspace>/.agents/skills,
 *   ~/.pi/agent/skills, ~/.agents/skills
 * Names are unique in what pi loads (first one discovered wins), so the same
 * rule is applied here.
 */
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { agentDir } from "./pi-settings.ts";

export interface SkillSummary {
  name: string;
  description: string;
  /** Absolute directory holding SKILL.md. */
  dir: string;
  scope: "project" | "user";
  /** Set when the skill opts out of automatic model selection. */
  manualOnly: boolean;
}

const SKILL_FILE = "SKILL.md";

/** Home directory, injectable so a test can keep its own skill roots. */
function homeDir(env: NodeJS.ProcessEnv): string {
  return env.HOME?.trim() || homedir();
}

export function listSkills(workspace: string, env: NodeJS.ProcessEnv = process.env): SkillSummary[] {
  const roots: Array<{ dir: string; scope: SkillSummary["scope"] }> = [
    { dir: join(workspace, ".pi", "skills"), scope: "project" },
    { dir: join(workspace, ".agents", "skills"), scope: "project" },
    { dir: join(agentDir(env), "skills"), scope: "user" },
    { dir: join(homeDir(env), ".agents", "skills"), scope: "user" },
  ];

  const found: SkillSummary[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    for (const dir of skillDirsIn(root.dir)) {
      const skill = readSkill(dir, root.scope);
      if (!skill || seen.has(skill.name)) continue;
      seen.add(skill.name);
      found.push(skill);
    }
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

/** Directories holding a SKILL.md, at most one level of nesting deep. */
function skillDirsIn(root: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const dirs: string[] = [];
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    const path = join(root, entry);
    try {
      if (!statSync(path).isDirectory()) continue;
    } catch {
      continue;
    }
    if (existsSync(join(path, SKILL_FILE))) {
      dirs.push(path);
      continue;
    }
    // pi discovers recursively; one extra level covers grouping directories
    // without turning this into a filesystem walk.
    for (const nested of safeReaddir(path)) {
      const nestedPath = join(path, nested);
      if (existsSync(join(nestedPath, SKILL_FILE))) dirs.push(nestedPath);
    }
  }
  return dirs;
}

function safeReaddir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function readSkill(dir: string, scope: SkillSummary["scope"]): SkillSummary | null {
  let text: string;
  try {
    text = readFileSync(join(dir, SKILL_FILE), "utf8");
  } catch {
    return null;
  }
  const front = parseFrontmatter(text);
  const name = front.name?.trim() || basename(dir);
  const description = front.description?.trim();
  // pi does not load a skill without a description; do not list a ghost.
  if (!description) return null;
  return {
    name,
    description,
    dir,
    scope,
    manualOnly: front["disable-model-invocation"] === "true",
  };
}

/**
 * Minimal frontmatter reader: top-level `key: value` pairs between `---` fences.
 *
 * Block scalars are supported, because a long description is usually written as
 * `description: >-` with the text on the following indented lines. Reading only
 * the first line would show a literal `>-` in the UI.
 */
function parseFrontmatter(text: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return {};
  const lines = match[1].split(/\r?\n/);
  const fields: Record<string, string> = {};

  for (let index = 0; index < lines.length; index += 1) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[index].trim());
    if (!kv) continue;
    const [, key, rawValue] = kv;
    const style = /^([>|])[+-]?$/.exec(rawValue.trim());

    if (!style) {
      fields[key] = rawValue.replace(/^["']|["']$/g, "");
      continue;
    }

    const block: string[] = [];
    while (index + 1 < lines.length && (/^\s+\S/.test(lines[index + 1]) || lines[index + 1].trim() === "")) {
      block.push(lines[index + 1].trim());
      index += 1;
    }
    // `>` folds newlines into spaces, `|` keeps them.
    fields[key] = style[1] === ">" ? block.join(" ").replace(/\s+/g, " ").trim() : block.join("\n").trim();
  }

  return fields;
}

/**
 * The whole SKILL.md, for the details view.
 *
 * Only directories the scan already reports are readable: the renderer never
 * names a path of its own, so this cannot be turned into a file reader.
 */
export function readSkillFile(
  dir: string,
  workspace: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (!listSkills(workspace, env).some((skill) => skill.dir === dir)) return null;
  try {
    return readFileSync(join(dir, SKILL_FILE), "utf8");
  } catch {
    return null;
  }
}

/**
 * Delete a skill directory.
 *
 * Guarded on purpose: the path must be a skill directory under a root this app
 * lists, so a stale or hostile entry in the UI cannot remove anything else.
 */
export function removeSkill(
  dir: string,
  workspace: string,
  env: NodeJS.ProcessEnv = process.env,
): SkillSummary[] {
  const target = resolve(dir);
  const roots = [
    resolve(join(workspace, ".pi", "skills")),
    resolve(join(workspace, ".agents", "skills")),
    resolve(join(agentDir(env), "skills")),
    resolve(join(homeDir(env), ".agents", "skills")),
  ];
  const inside = roots.some((root) => target.startsWith(`${root}/`) && target !== root);
  if (!inside || !existsSync(join(target, SKILL_FILE))) {
    throw new Error("不在可管理的技能目录内，拒绝删除");
  }
  rmSync(target, { recursive: true, force: true });
  return listSkills(workspace, env);
}
