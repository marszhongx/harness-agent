import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { SessionStore } from "./session-store.ts";
import { attachExistingTranscript } from "./transcript-sync.ts";

let dir: string;
let store: SessionStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "transcript-sync-"));
  store = new SessionStore(join(dir, "sessions.json"));
  store.createWithId("session-1");
});

describe("attachExistingTranscript", () => {
  it("records a transcript that pi has actually written", () => {
    const file = join(dir, "transcript.jsonl");
    writeFileSync(file, "");

    expect(attachExistingTranscript(store, "session-1", file)).toBe(true);
    expect(store.get("session-1")?.sessionFile).toBe("transcript.jsonl");
  });

  it("leaves the index alone when pi only planned the path", () => {
    expect(attachExistingTranscript(store, "session-1", join(dir, "missing.jsonl"))).toBe(false);
    expect(store.get("session-1")?.sessionFile).toBeUndefined();
  });

  it("ignores a missing path", () => {
    expect(attachExistingTranscript(store, "session-1", null)).toBe(false);
    expect(attachExistingTranscript(store, "session-1", undefined)).toBe(false);
  });
});
