/**
 * Transcript projection: turning pi's messages and tool events into the small
 * line model the UI draws.
 *
 * Pure functions on purpose — no process, no timers, no electron — so the rules
 * that decide "which tool output reaches the screen" can be tested directly.
 */
import type { TranscriptItem } from "./protocol.ts";

interface MessageLike {
  role?: string;
  content?: unknown;
}

interface PartLike {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  id?: string;
  arguments?: unknown;
}

interface MessageLikeExtended extends MessageLike {
  toolCallId?: string;
  isError?: boolean;
}

const SUMMARY_LIMIT = 120;
const TOOL_TEXT_LIMIT = 4000;

/**
 * One line that says what a tool is doing with what. The renderer never parses
 * arguments, so the wire carries the sentence instead of the object.
 */
export function summarizeTool(toolName: string, args: unknown): string {
  const record = (args ?? {}) as Record<string, unknown>;
  const firstString = (value: unknown): string | undefined => {
    if (typeof value === "string" && value.trim()) return value;
    if (Array.isArray(value)) {
      const hit = value.find((item) => typeof item === "string" && item.trim());
      return typeof hit === "string" ? hit : undefined;
    }
    return undefined;
  };

  const preferred =
    toolName === "bash"
      ? firstString(record.command)
      : toolName === "grep"
        ? firstString(record.pattern)
        : (firstString(record.path) ?? firstString(record.file_path) ?? firstString(record.url));
  const picked =
    preferred ??
    Object.values(record)
      .map(firstString)
      .find((value) => value !== undefined);
  const text = (picked ?? "").replace(/\s+/g, " ").trim();
  return text.length > SUMMARY_LIMIT ? `${text.slice(0, SUMMARY_LIMIT)}…` : text;
}

/**
 * Text out of a pi tool result.
 *
 * Two shapes reach here: the live event's `{content: [{type:"text", text}]}`, and
 * a stored `toolResult` message whose `content` *is* that array. Both are
 * accepted — the history path used to print the array as JSON.
 */
export function toolResultText(result: unknown, limit = TOOL_TEXT_LIMIT): string {
  if (typeof result === "string") return clip(result, limit);
  const content = Array.isArray(result) ? result : (result as { content?: unknown } | null)?.content;
  if (Array.isArray(content)) {
    const text = content
      .map((part) => {
        const piece = part as { type?: string; text?: string };
        return piece?.type === "text" ? (piece.text ?? "") : "";
      })
      .join("");
    if (text.trim()) return clip(text, limit);
  }
  try {
    return clip(JSON.stringify(result ?? ""), limit);
  } catch {
    return "";
  }
}

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}\n… (${text.length - limit} more chars)` : text;
}

/**
 * Flatten pi's messages into the UI's line model.
 *
 * Dropped on purpose: `system` (never shown) and `toolResult` (the tool card
 * carries the outcome; raw output is long and nobody scrolls it).
 */
export function toTranscript(messages: unknown[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  // toolCallId -> the item it created, so the matching toolResult can fill in
  // the output without a second pass.
  const toolItems = new Map<string, Extract<TranscriptItem, { kind: "tool" }>>();
  for (const raw of messages) {
    const message = raw as MessageLikeExtended;
    const role = message.role;
    if (role === "toolResult") {
      const item = message.toolCallId ? toolItems.get(message.toolCallId) : undefined;
      if (item) {
        item.text = toolResultText(message.content);
        item.isError = message.isError === true;
      }
      continue;
    }
    if (role !== "user" && role !== "assistant") continue;
    const content = message.content;
    if (typeof content === "string") {
      if (content.trim()) items.push({ kind: role, text: content });
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const rawPart of content) {
      const part = rawPart as PartLike;
      if (part.type === "text" && part.text?.trim()) {
        items.push({ kind: role, text: part.text });
      } else if (part.type === "thinking" && part.thinking?.trim() && role === "assistant") {
        items.push({ kind: "thinking", text: part.thinking });
      } else if (part.type === "toolCall" && role === "assistant") {
        const name = String(part.name ?? "tool");
        const item: Extract<TranscriptItem, { kind: "tool" }> = {
          kind: "tool",
          name,
          summary: summarizeTool(name, part.arguments),
        };
        items.push(item);
        if (typeof part.id === "string") toolItems.set(part.id, item);
      }
    }
  }
  return items;
}
