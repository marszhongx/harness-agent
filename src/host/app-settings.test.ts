import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { AppSettingsStore } from "./app-settings.ts";

let path: string;

beforeEach(() => {
  path = join(mkdtempSync(join(tmpdir(), "app-settings-")), "settings.json");
});

describe("AppSettingsStore", () => {
  it("falls back to defaults", () => {
    expect(new AppSettingsStore(path).value).toEqual({
      version: 1,
      theme: "system",
      launchAtLogin: false,
      workspacePath: null,
    });
  });

  it("persists an update and reloads it", () => {
    const store = new AppSettingsStore(path);
    store.update({ theme: "dark", launchAtLogin: true, workspacePath: "/tmp/ws" });

    expect(new AppSettingsStore(path).value).toEqual({
      version: 1,
      theme: "dark",
      launchAtLogin: true,
      workspacePath: "/tmp/ws",
    });
  });

  it("keeps the version and ignores unknown keys on load", () => {
    writeFileSync(path, JSON.stringify({ version: 1, theme: "light", surprise: 42 }));
    const store = new AppSettingsStore(path);
    expect(store.value.theme).toBe("light");
    expect(store.value).not.toHaveProperty("surprise");
  });

  it("repairs an unknown theme and a non-string workspace", () => {
    writeFileSync(path, JSON.stringify({ version: 1, theme: "neon", workspacePath: 7 }));
    expect(new AppSettingsStore(path).value).toMatchObject({ theme: "system", workspacePath: null });
  });

  it("starts from defaults when the file is corrupt", () => {
    writeFileSync(path, "{ broken");
    expect(new AppSettingsStore(path).value.theme).toBe("system");
  });

  it("writes JSON that parses back", () => {
    const store = new AppSettingsStore(path);
    store.update({ theme: "dark" });
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ theme: "dark", version: 1 });
  });
});
