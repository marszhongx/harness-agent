import { describe, expect, it } from "vitest";
import { summarizeTool, toolResultText, toTranscript } from "./transcript.ts";

describe("summarizeTool", () => {
  it("shows the command for bash", () => {
    expect(summarizeTool("bash", { command: "ls -la" })).toBe("ls -la");
  });

  it("shows the pattern for grep and the path for file tools", () => {
    expect(summarizeTool("grep", { pattern: "TODO", path: "src" })).toBe("TODO");
    expect(summarizeTool("read", { path: "/tmp/a.txt" })).toBe("/tmp/a.txt");
    expect(summarizeTool("edit", { file_path: "/tmp/b.ts" })).toBe("/tmp/b.ts");
  });

  it("falls back to the first string argument", () => {
    expect(summarizeTool("custom", { whatever: 1, note: "hello" })).toBe("hello");
  });

  it("collapses whitespace and truncates", () => {
    expect(summarizeTool("bash", { command: "echo a\n\n echo   b" })).toBe("echo a echo b");
    expect(summarizeTool("bash", { command: "x".repeat(200) })).toHaveLength(121);
  });

  it("returns an empty string when there is nothing to show", () => {
    expect(summarizeTool("bash", {})).toBe("");
    expect(summarizeTool("bash", undefined)).toBe("");
  });
});

describe("toolResultText", () => {
  const parts = [{ type: "text", text: "hello\n" }];

  it("reads the live event shape", () => {
    expect(toolResultText({ content: parts })).toBe("hello\n");
  });

  it("reads a stored toolResult message (bare content array)", () => {
    expect(toolResultText(parts)).toBe("hello\n");
  });

  it("passes strings through and stringifies the rest", () => {
    expect(toolResultText("plain")).toBe("plain");
    expect(toolResultText({ structuredContent: { ok: 1 } })).toContain("structuredContent");
  });

  it("caps very long output and says how much was dropped", () => {
    const long = "a".repeat(5000);
    const text = toolResultText({ content: [{ type: "text", text: long }] });
    expect(text.length).toBeLessThan(5000);
    expect(text).toContain("more chars");
  });
});

describe("toTranscript", () => {
  it("skips the system prompt and pairs tool calls with their results", () => {
    const items = toTranscript([
      { role: "system", content: "you are pi" },
      { role: "user", content: [{ type: "text", text: "run it" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "let me check" },
          { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "echo hi" } },
        ],
      },
      { role: "toolResult", toolCallId: "call-1", content: [{ type: "text", text: "hi\n" }] },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ]);

    expect(items).toEqual([
      { kind: "user", text: "run it" },
      { kind: "thinking", text: "let me check" },
      { kind: "tool", name: "bash", summary: "echo hi", text: "hi\n", isError: false },
      { kind: "assistant", text: "done" },
    ]);
  });

  it("marks a failed tool", () => {
    const items = toTranscript([
      { role: "assistant", content: [{ type: "toolCall", id: "c", name: "bash", arguments: {} }] },
      { role: "toolResult", toolCallId: "c", isError: true, content: [{ type: "text", text: "boom" }] },
    ]);
    expect(items).toEqual([{ kind: "tool", name: "bash", summary: "", text: "boom", isError: true }]);
  });

  it("leaves a tool without a result pending (no text, not an error)", () => {
    const items = toTranscript([
      { role: "assistant", content: [{ type: "toolCall", id: "c", name: "read", arguments: { path: "x" } }] },
    ]);
    expect(items).toEqual([{ kind: "tool", name: "read", summary: "x" }]);
  });

  it("accepts plain string content and ignores unknown roles", () => {
    const items = toTranscript([
      { role: "user", content: "hi" },
      { role: "summary", content: "ignored" },
      { role: "assistant", content: "   " },
    ]);
    expect(items).toEqual([{ kind: "user", text: "hi" }]);
  });
});
