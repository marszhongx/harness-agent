import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { listSkills, readSkillFile, removeSkill } from "./skills.ts";

let root: string;
let workspace: string;
let env: NodeJS.ProcessEnv;

const skill = (dir: string, body: string) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), body);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "skills-"));
  workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  // HOME is pinned too: the real ~/.agents/skills must not leak into the scan.
  env = { HOME: root, PI_CODING_AGENT_DIR: join(root, "agent") };
});

describe("listSkills", () => {
  it("returns nothing when no skill directory exists", () => {
    expect(listSkills(workspace, env)).toEqual([]);
  });

  it("reads name and description from the frontmatter", () => {
    skill(
      join(workspace, ".pi", "skills", "pdf-tools"),
      "---\nname: pdf-tools\ndescription: Read PDFs.\n---\n\n# body\n",
    );
    expect(listSkills(workspace, env)).toEqual([
      {
        name: "pdf-tools",
        description: "Read PDFs.",
        dir: join(workspace, ".pi", "skills", "pdf-tools"),
        scope: "project",
        manualOnly: false,
      },
    ]);
  });

  it("folds a block-scalar description instead of showing the marker", () => {
    skill(
      join(workspace, ".pi", "skills", "long"),
      "---\nname: long\ndescription: >-\n  First line of the\n  description.\n  Third one.\n---\n\n# body\n",
    );

    expect(listSkills(workspace, env)[0]?.description).toBe("First line of the description. Third one.");
  });

  it("keeps the newlines of a literal block scalar", () => {
    skill(
      join(workspace, ".pi", "skills", "literal"),
      "---\nname: literal\ndescription: |\n  First.\n  Second.\n---\n\n# body\n",
    );

    expect(listSkills(workspace, env)[0]?.description).toBe("First.\nSecond.");
  });

  it("falls back to the directory name and marks manual-only skills", () => {
    skill(
      join(env.PI_CODING_AGENT_DIR as string, "skills", "no-name"),
      "---\ndescription: No name field.\ndisable-model-invocation: true\n---\n",
    );
    const [entry] = listSkills(workspace, env);
    expect(entry).toMatchObject({ name: "no-name", scope: "user", manualOnly: true });
  });

  it("skips a skill without a description (pi would not load it)", () => {
    skill(join(workspace, ".pi", "skills", "empty"), "---\nname: empty\n---\n");
    expect(listSkills(workspace, env)).toEqual([]);
  });

  it("finds skills nested one level down", () => {
    skill(
      join(workspace, ".agents", "skills", "group", "inner"),
      "---\nname: inner\ndescription: nested\n---\n",
    );
    expect(listSkills(workspace, env).map((entry) => entry.name)).toEqual(["inner"]);
  });

  it("scans only the supplied root", () => {
    const onlyRoot = join(workspace, ".agents", "skills");
    skill(join(onlyRoot, "local"), "---\nname: local\ndescription: local one\n---\n");
    skill(join(workspace, ".pi", "skills", "project"), "---\nname: project\ndescription: project one\n---\n");
    skill(
      join(env.PI_CODING_AGENT_DIR as string, "skills", "global"),
      "---\nname: global\ndescription: global one\n---\n",
    );

    expect(listSkills(workspace, env, { onlyRoot })).toEqual([
      {
        name: "local",
        description: "local one",
        dir: join(onlyRoot, "local"),
        scope: "project",
        manualOnly: false,
      },
    ]);
  });

  it("can exclude user roots while keeping project roots", () => {
    skill(join(workspace, ".pi", "skills", "project"), "---\nname: project\ndescription: project one\n---\n");
    skill(
      join(workspace, ".agents", "skills", "agents"),
      "---\nname: agents\ndescription: agents one\n---\n",
    );
    skill(
      join(env.PI_CODING_AGENT_DIR as string, "skills", "user"),
      "---\nname: user\ndescription: user one\n---\n",
    );
    skill(join(root, ".agents", "skills", "global"), "---\nname: global\ndescription: global one\n---\n");

    expect(listSkills(workspace, env, { includeUser: false }).map((entry) => entry.name)).toEqual([
      "agents",
      "project",
    ]);
  });

  it("keeps the first of two skills with the same name, like pi does", () => {
    skill(join(workspace, ".pi", "skills", "dup"), "---\nname: dup\ndescription: project one\n---\n");
    skill(
      join(env.PI_CODING_AGENT_DIR as string, "skills", "dup"),
      "---\nname: dup\ndescription: user one\n---\n",
    );
    const [entry] = listSkills(workspace, env);
    expect(entry.scope).toBe("project");
    expect(entry.description).toBe("project one");
  });
});

describe("readSkillFile", () => {
  it("returns the whole file for a skill it lists", () => {
    const dir = join(workspace, ".pi", "skills", "pdf-tools");
    skill(dir, "---\nname: pdf-tools\ndescription: Read PDFs.\n---\n\n# body\n");
    expect(readSkillFile(dir, workspace, env)).toContain("# body");
  });

  it("refuses a directory it does not list", () => {
    const outside = join(root, "elsewhere");
    skill(outside, "---\nname: x\ndescription: y\n---\n");
    expect(readSkillFile(outside, workspace, env)).toBeNull();
  });

  it("reads and removes only the supplied root", () => {
    const onlyRoot = join(workspace, ".agents", "skills");
    const localSkill = join(onlyRoot, "local");
    const projectSkill = join(workspace, ".pi", "skills", "project");
    skill(localSkill, "---\nname: local\ndescription: local one\n---\n");
    skill(projectSkill, "---\nname: project\ndescription: project one\n---\n");

    expect(readSkillFile(localSkill, workspace, env, { onlyRoot })).toContain("local one");
    expect(readSkillFile(projectSkill, workspace, env, { onlyRoot })).toBeNull();
    expect(() => removeSkill(projectSkill, workspace, env, { onlyRoot })).toThrow(/拒绝删除/);

    expect(removeSkill(localSkill, workspace, env, { onlyRoot })).toEqual([]);
  });
});

describe("removeSkill", () => {
  it("deletes a skill inside a known root", () => {
    const dir = join(workspace, ".pi", "skills", "gone");
    skill(dir, "---\nname: gone\ndescription: x\n---\n");
    expect(removeSkill(dir, workspace, env)).toEqual([]);
    expect(listSkills(workspace, env)).toEqual([]);
  });

  it("refuses a directory outside the skill roots", () => {
    const outside = join(root, "elsewhere");
    skill(outside, "---\nname: x\ndescription: y\n---\n");
    expect(() => removeSkill(outside, workspace, env)).toThrow(/拒绝删除/);
  });

  it("refuses a root itself", () => {
    const skillsRoot = join(workspace, ".pi", "skills");
    mkdirSync(skillsRoot, { recursive: true });
    expect(() => removeSkill(skillsRoot, workspace, env)).toThrow();
  });
});
