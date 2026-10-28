// @vitest-environment happy-dom
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import ToolCard from "./components/ToolCard";
import Transcript from "./components/Transcript";
import type { Item } from "./store/item";
import { historyToItems, useTranscript } from "./store/transcript";
import { resetStores } from "./test/reset";

beforeEach(() => resetStores());

const store = () => useTranscript.getState();
const items = (sessionId: string) => store().getItems(sessionId);
const kinds = (sessionId: string) =>
  items(sessionId)
    .map((item) => item.kind)
    .join(",");

describe("historyToItems", () => {
  it("maps a stored transcript onto the line model", () => {
    const items = historyToItems([
      { kind: "user", text: "跑测试" },
      { kind: "thinking", text: "先看看" },
      { kind: "tool", name: "bash", summary: "pnpm test", text: "ok", isError: false },
      { kind: "assistant", text: "全绿" },
    ]);

    expect(items.map((item) => item.kind)).toEqual(["user", "thinking", "tool", "assistant"]);
    expect(items[2]).toMatchObject({ name: "bash", summary: "pnpm test", text: "ok", running: false });
  });

  it("returns nothing for an empty transcript", () => {
    expect(historyToItems(null)).toEqual([]);
  });
});

describe("transcript store", () => {
  it("appends deltas to a single assistant line", () => {
    store().ingest({ type: "text_delta", sessionId: "s1", delta: "你好" });
    store().ingest({ type: "text_delta", sessionId: "s1", delta: "，世界" });

    expect(items("s1")).toHaveLength(1);
    expect(items("s1")[0]).toMatchObject({ kind: "assistant", text: "你好，世界" });
  });

  it("keeps conversations apart", () => {
    store().ingest({ type: "text_delta", sessionId: "s1", delta: "one" });
    store().ingest({ type: "text_delta", sessionId: "s2", delta: "two" });

    expect(items("s1")[0]).toMatchObject({ text: "one" });
    expect(items("s2")[0]).toMatchObject({ text: "two" });
  });

  it("tracks a tool from start to result", () => {
    store().ingest({
      type: "tool_start",
      sessionId: "s1",
      toolName: "bash",
      toolCallId: "c1",
      summary: "ls",
    });
    expect(items("s1")[0]).toMatchObject({ running: true, summary: "ls" });

    store().ingest({
      type: "tool_end",
      sessionId: "s1",
      toolCallId: "c1",
      isError: false,
      text: "a b",
      durationMs: 7,
    });
    expect(items("s1")[0]).toMatchObject({ running: false, text: "a b", durationMs: 7 });
  });

  it("clears busy and records failures and notices", () => {
    store().ingest({ type: "error", sessionId: "s1", message: "模型挂了" });
    expect(store().getBusy("s1")).toBe(false);
    expect(kinds("s1")).toBe("notice");

    store().ingest({ type: "notify", sessionId: "s1", message: "提示" });
    expect(items("s1").at(-1)).toMatchObject({ kind: "notice", text: "提示" });
  });

  it("keeps a conversation's snapshot and untouched lines stable", () => {
    store().ingest({ type: "text_delta", sessionId: "s1", delta: "a" });
    store().ingest({
      type: "tool_start",
      sessionId: "s1",
      toolName: "bash",
      toolCallId: "c1",
      summary: "ls",
    });
    const before = items("s1");
    const [first, second] = before;

    // Another conversation streaming must not invalidate this one's snapshot.
    store().ingest({ type: "text_delta", sessionId: "s2", delta: "b" });
    expect(items("s1")).toBe(before);

    // A delta only replaces the line it appends to; the rest keep their identity,
    // which is what lets the memoized rows skip re-rendering.
    store().ingest({ type: "text_delta", sessionId: "s1", delta: "!" });
    expect(items("s1").slice(0, 2)).toEqual([first, second]);
    expect(items("s1")[0]).toBe(first);
    expect(items("s1")[1]).toBe(second);
  });

  it("keeps the line list untouched when only busy changes", () => {
    store().ingest({ type: "text_delta", sessionId: "s1", delta: "x" });
    const before = items("s1");

    store().setBusy("s1", true);
    expect(store().getBusy("s1")).toBe(true);
    expect(items("s1")).toBe(before);

    store().ingest({ type: "settled", sessionId: "s1" });
    expect(store().getBusy("s1")).toBe(false);
    expect(items("s1")).toBe(before);
  });

  it("ignores events without a conversation", () => {
    store().ingest({ type: "text_delta", delta: "orphan" });
    expect(items("s1")).toEqual([]);
  });

  it("replaces a conversation with a restored one", () => {
    store().replace("s1", [{ id: 1, kind: "user", text: "旧" }]);
    store().replace("s1", historyToItems([{ kind: "user", text: "新" }]));
    expect(items("s1")).toHaveLength(1);
    expect(items("s1")[0]).toMatchObject({ text: "新" });
  });
});

describe("Transcript", () => {
  it("renders user, thinking, tool and assistant lines", () => {
    const items: Item[] = historyToItems([
      { kind: "user", text: "跑一下测试" },
      { kind: "thinking", text: "先看看有没有测试脚本" },
      { kind: "tool", name: "bash", summary: "pnpm test", text: "73 passed" },
      { kind: "assistant", text: "全部通过。" },
    ]);

    render(<Transcript items={items} />);
    expect(screen.getByText("跑一下测试")).toBeTruthy();
    expect(screen.getByText("先看看有没有测试脚本")).toBeTruthy();
    expect(screen.getByText("bash")).toBeTruthy();
    expect(screen.getByText("pnpm test")).toBeTruthy();
    expect(screen.getByText("全部通过。")).toBeTruthy();
  });

  it("renders nothing for an empty conversation", () => {
    const { container } = render(<Transcript items={[]} />);
    expect(container.firstElementChild?.children).toHaveLength(0);
  });
});

describe("ToolCard", () => {
  it("shows the duration of a finished call", () => {
    render(<ToolCard name="bash" summary="echo hi" text="hi" durationMs={12} running={false} />);
    expect(screen.getByText("12ms")).toBeTruthy();
  });

  it("opens itself when the call failed", () => {
    render(<ToolCard name="read" summary="missing.txt" text="ENOENT" isError running={false} />);
    expect(screen.getByText("失败")).toBeTruthy();
    expect(screen.getByText("ENOENT")).toBeTruthy();
  });
});
