import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { SessionStore } from "./session-store.ts";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "session-store-"));
  path = join(dir, "sessions.json");
});

const read = () => JSON.parse(readFileSync(path, "utf8"));

describe("SessionStore", () => {
  it("starts empty when the file is missing", () => {
    expect(new SessionStore(path).list()).toEqual([]);
  });

  it("starts empty when the file is corrupt instead of throwing", () => {
    writeFileSync(path, "{ not json");
    expect(new SessionStore(path).list()).toEqual([]);
  });

  it("creates a session, makes it current and persists it", () => {
    const store = new SessionStore(path);
    const id = store.create("/tmp/ws");

    expect(store.get(id)).toMatchObject({
      id,
      title: "新会话",
      workspacePath: "/tmp/ws",
    });
    expect(new SessionStore(path).get(id)?.workspacePath).toBe("/tmp/ws");
  });

  it("removes a session and hands back what it pointed at", () => {
    const store = new SessionStore(path);
    const id = store.create("/tmp/ws");
    store.attachFile(id, "/sessions/2026-01-01_abc.jsonl");

    const removed = store.remove(id);

    expect(removed?.sessionFile).toBe("2026-01-01_abc.jsonl");
    expect(store.get(id)).toBeUndefined();
    expect(new SessionStore(path).list()).toEqual([]);
    expect(store.remove(id)).toBeUndefined();
  });

  it("records a session under an id that was already handed to pi", () => {
    const store = new SessionStore(path);
    store.createWithId("harness-agent-draft", "/tmp/ws");

    expect(store.get("harness-agent-draft")).toMatchObject({ title: "新会话", workspacePath: "/tmp/ws" });
  });

  it("orders the list by recency", () => {
    const store = new SessionStore(path);
    const first = store.create();
    const second = store.create();
    store.touch(first);

    expect(store.list().map((entry) => entry.id)).toEqual([first, second]);
  });

  it("takes the title from the first message only", () => {
    const store = new SessionStore(path);
    const id = store.create();

    store.touch(id, "  第一句话 \n 后面的  ");
    expect(store.get(id)?.title).toBe("第一句话 后面的");

    store.touch(id, "第二句");
    expect(store.get(id)?.title).toBe("第一句话 后面的");
  });

  it("truncates a long title", () => {
    const store = new SessionStore(path);
    const id = store.create();
    store.touch(id, "长".repeat(120));
    expect(store.get(id)?.title).toHaveLength(49);
    expect(store.get(id)?.title?.endsWith("…")).toBe(true);
  });

  it("keeps model and thinking level", () => {
    const store = new SessionStore(path);
    const id = store.create();
    store.setModel(id, "hifox", "glm-5.3-flash");
    store.setThinkingLevel(id, "high");

    expect(new SessionStore(path).get(id)).toMatchObject({
      model: { provider: "hifox", id: "glm-5.3-flash" },
      thinkingLevel: "high",
    });
  });

  it("records the transcript only when told to", () => {
    const store = new SessionStore(path);
    const id = store.create();
    store.attachFile(id, "2026-01-01_abc.jsonl");
    expect(store.get(id)?.sessionFile).toBe("2026-01-01_abc.jsonl");
  });

  it("filters the list by workspace", () => {
    const store = new SessionStore(path);
    const a = store.create("/ws-a");
    const b = store.create("/ws-b");

    expect(store.list("/ws-a").map((entry) => entry.id)).toEqual([a]);
    expect(store.list("/ws-b").map((entry) => entry.id)).toEqual([b]);
    expect(store.list()).toHaveLength(2);
  });

  describe("pruneEmpty", () => {
    it("drops a session that never got a message and has no transcript", () => {
      const store = new SessionStore(path);
      const id = store.create("/ws");
      expect(store.pruneEmpty(() => false)).toBe(1);
      expect(store.get(id)).toBeUndefined();
    });

    it("keeps a session whose transcript exists even without a title", () => {
      const store = new SessionStore(path);
      const id = store.create();
      store.attachFile(id, "exists.jsonl");
      expect(store.pruneEmpty((file) => file === "exists.jsonl")).toBe(0);
      expect(store.get(id)).toBeDefined();
    });

    it("keeps a titled session even when the file is gone", () => {
      const store = new SessionStore(path);
      const id = store.create();
      store.touch(id, "hello");
      expect(store.pruneEmpty(() => false)).toBe(0);
    });

    it("does not write when nothing is pruned", () => {
      const store = new SessionStore(path);
      store.create();
      const before = read();
      expect(store.pruneEmpty(() => false)).toBe(1);
      expect(read()).not.toEqual(before);
    });
  });

  it("ignores unknown ids", () => {
    const store = new SessionStore(path);
    expect(() => store.touch("nope", "x")).not.toThrow();
    expect(() => store.setModel("nope", "p", "m")).not.toThrow();
  });
});
