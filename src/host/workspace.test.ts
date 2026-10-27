import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { checkWorkspace, ensureDefaultWorkspace } from "./workspace.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "workspace-"));
});

describe("ensureDefaultWorkspace", () => {
  it("keeps a directory that already exists", () => {
    expect(ensureDefaultWorkspace(() => root)).toBe(root);
  });

  it("creates the app's own directory when it is missing", () => {
    const missing = join(root, "workspace");
    expect(ensureDefaultWorkspace(() => missing)).toBe(missing);
  });
});

describe("checkWorkspace", () => {
  it("accepts a directory", () => {
    const dir = join(root, "project");
    mkdirSync(dir);
    expect(checkWorkspace(dir)).toBeNull();
  });

  it("reports a missing directory instead of replacing it", () => {
    expect(checkWorkspace(join(root, "gone"))).toMatch(/不存在/);
  });

  it("reports a path that is a file", () => {
    const file = join(root, "notes.txt");
    writeFileSync(file, "x");
    expect(checkWorkspace(file)).toMatch(/不是文件夹/);
  });
});
