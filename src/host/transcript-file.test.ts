import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readTranscript } from "./transcript-file.ts";

const write = (lines: unknown[]): string => {
  const file = join(mkdtempSync(join(tmpdir(), "transcript-")), "s.jsonl");
  writeFileSync(
    file,
    lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n"),
  );
  return file;
};

const header = { type: "session", version: 3, id: "s-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/ws" };
const message = (id: string, role: string, content: unknown, parentId: string | null = null) => ({
  type: "message",
  id,
  parentId,
  timestamp: "2026-01-01T00:00:01.000Z",
  message: { role, content },
});

describe("readTranscript", () => {
  it("returns nothing for a missing or empty file", () => {
    expect(readTranscript("/nope/missing.jsonl")).toEqual([]);
    expect(readTranscript(write([]))).toEqual([]);
  });

  it("reads user, assistant, thinking and tool traffic in order", () => {
    const file = write([
      header,
      message("a1", "user", [{ type: "text", text: "跑测试" }]),
      message(
        "b2",
        "assistant",
        [
          { type: "thinking", thinking: "先看看" },
          { type: "toolCall", id: "c1", name: "bash", arguments: { command: "pnpm test" } },
        ],
        "a1",
      ),
      {
        type: "message",
        id: "c3",
        parentId: "b2",
        message: { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "ok" }] },
      },
      message("d4", "assistant", [{ type: "text", text: "全绿" }], "c3"),
    ]);

    expect(readTranscript(file)).toEqual([
      { kind: "user", text: "跑测试" },
      { kind: "thinking", text: "先看看" },
      { kind: "tool", name: "bash", summary: "pnpm test", text: "ok", isError: false },
      { kind: "assistant", text: "全绿" },
    ]);
  });

  it("skips bookkeeping entries and the system prompt", () => {
    const file = write([
      header,
      message("s0", "system", ""),
      { type: "model_change", id: "m1", parentId: "s0", provider: "p", modelId: "m" },
      { type: "usage", id: "u1", parentId: "m1", kind: "cache_warm", usage: {} },
      message("a1", "user", "hi"),
    ]);
    expect(readTranscript(file)).toEqual([{ kind: "user", text: "hi" }]);
  });

  it("follows the active branch instead of replaying an abandoned one", () => {
    // a1 -> b1 (taken) ; a1 -> b2 (abandoned) ; b1 -> a2 (newest, the leaf)
    const file = write([
      header,
      message("a1", "user", "第一个问题"),
      { ...message("b1", "assistant", "第一次回答"), parentId: "a1" },
      { ...message("b2", "assistant", "另一条分支的回答"), parentId: "a1" },
      { ...message("a2", "user", "继续"), parentId: "b1" },
    ]);

    const items = readTranscript(file);
    expect(
      items.map((item) => (item.kind === "user" || item.kind === "assistant" ? item.text : item.kind)),
    ).toEqual(["第一个问题", "第一次回答", "继续"]);
  });

  it("ignores a torn last line", () => {
    const file = write([header, message("a1", "user", "hi"), '{"type":"message","id":"b2","mess']);
    expect(readTranscript(file)).toEqual([{ kind: "user", text: "hi" }]);
  });

  it("stops on a cycle instead of looping forever", () => {
    const file = write([
      header,
      { ...message("a1", "user", "循环"), parentId: "b1" },
      { ...message("b1", "assistant", "也循环"), parentId: "a1" },
    ]);
    expect(readTranscript(file)).toHaveLength(2);
  });
});
