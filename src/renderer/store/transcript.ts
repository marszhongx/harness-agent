/**
 * Transcripts for every conversation, in one store keyed by session id.
 *
 * The lines are not app state: only the view showing a conversation subscribes
 * to it, and it must survive switching away and back. Keeping them keyed lets a
 * component subscribe to `(s) => s.getItems(id)` — the value is an array that
 * only changes when that conversation changes, so a background conversation
 * streaming never re-renders the view on screen.
 */
import { create } from "zustand";
import { type AgentEvent, agent, type TranscriptItem } from "../lib/agent";
import { useAgentStream } from "./agent-stream";
import { type Item, nextItemId } from "./item";

const NO_ITEMS: Item[] = [];
const DRAFT = "";

/** Copy-on-write map update, the shape zustand needs for a Map value. */
function put<K, V>(map: Map<K, V>, key: K, value: V): Map<K, V> {
  const next = new Map(map);
  next.set(key, value);
  return next;
}

/** Extend the last line when it is of the same kind, otherwise start a new one. */
function appendText(items: Item[], kind: "assistant" | "thinking", delta: string): Item[] {
  const last = items.at(-1);
  return last?.kind === kind
    ? [...items.slice(0, -1), { ...last, text: last.text + delta }]
    : [...items, { id: nextItemId(), kind, text: delta }];
}

type ToolItem = Extract<Item, { kind: "tool" }>;

function patchTool(items: Item[], callId: unknown, patch: (item: ToolItem) => Item): Item[] {
  return items.map((item) => (item.kind === "tool" && item.callId === callId ? patch(item) : item));
}

export type TranscriptState = {
  /** `""` holds the new-conversation page, which has no id yet. */
  items: Map<string, Item[]>;
  busy: Map<string, boolean>;
  getItems: (sessionId: string | null) => Item[];
  getBusy: (sessionId: string | null) => boolean;
  /** Fold one agent event into the conversation it belongs to. */
  ingest: (event: AgentEvent) => void;
  /** Add a line (the user's own message). */
  append: (sessionId: string, item: Item) => void;
  /** Replace the lines (restored history). */
  replace: (sessionId: string, items: Item[]) => void;
  /** Forget a conversation that no longer exists. */
  drop: (sessionId: string) => void;
  setBusy: (sessionId: string, busy: boolean) => void;
};

export const useTranscript = create<TranscriptState>((set, get) => {
  const key = (sessionId: string | null) => sessionId ?? DRAFT;

  const setItems = (sessionId: string, items: Item[]) => set({ items: put(get().items, sessionId, items) });

  return {
    items: new Map(),
    busy: new Map(),

    getItems: (sessionId) => get().items.get(key(sessionId)) ?? NO_ITEMS,
    getBusy: (sessionId) => get().busy.get(key(sessionId)) ?? false,

    append: (sessionId, item) => setItems(sessionId, [...(get().items.get(sessionId) ?? NO_ITEMS), item]),

    replace: (sessionId, items) => setItems(sessionId, items),

    drop: (sessionId) => {
      const items = new Map(get().items);
      const busy = new Map(get().busy);
      items.delete(sessionId);
      busy.delete(sessionId);
      set({ items, busy });
    },

    setBusy: (sessionId, busy) => set({ busy: put(get().busy, sessionId, busy) }),

    ingest: (event) => {
      const sessionId = typeof event.sessionId === "string" ? event.sessionId : "";
      if (!sessionId) return;

      const items = get().items.get(sessionId) ?? NO_ITEMS;
      switch (event.type) {
        case "text_delta":
          return setItems(sessionId, appendText(items, "assistant", String(event.delta ?? "")));
        case "thinking_delta":
          return setItems(sessionId, appendText(items, "thinking", String(event.delta ?? "")));
        case "tool_start":
          return setItems(sessionId, [
            ...items,
            {
              id: nextItemId(),
              kind: "tool",
              callId: typeof event.toolCallId === "string" ? event.toolCallId : undefined,
              name: String(event.toolName ?? "tool"),
              summary: typeof event.summary === "string" ? event.summary : undefined,
              running: true,
            },
          ]);
        case "tool_update": {
          const text = String(event.text ?? "");
          if (!text) return;
          return setItems(
            sessionId,
            patchTool(items, event.toolCallId, (item) => ({
              ...item,
              text: ((item.text ?? "") + text).slice(-8000),
            })),
          );
        }
        case "tool_end":
          return setItems(
            sessionId,
            patchTool(items, event.toolCallId, (item) => ({
              ...item,
              running: false,
              isError: event.isError === true,
              text: typeof event.text === "string" && event.text ? event.text : item.text,
              durationMs: typeof event.durationMs === "number" ? event.durationMs : undefined,
            })),
          );
        case "settled":
          return get().setBusy(sessionId, false);
        case "error":
          setItems(sessionId, [
            ...items,
            { id: nextItemId(), kind: "notice", text: String(event.message ?? "未知错误"), error: true },
          ]);
          return get().setBusy(sessionId, false);
        case "notify":
          return setItems(sessionId, [
            ...items,
            { id: nextItemId(), kind: "notice", text: String(event.message ?? "") },
          ]);
        default:
          return;
      }
    },
  };
});

/** Imperative access from event handlers and other stores. */
export const getTranscript = useTranscript.getState;

/** The one place the agent event stream is wired to the store. */
function startTranscriptSync(): () => void {
  return agent().onEvent((event) => getTranscript().ingest(event));
}

export function useTranscriptSync(): void {
  useAgentStream(startTranscriptSync);
}

export function historyToItems(history: TranscriptItem[] | null): Item[] {
  return (history ?? []).flatMap<Item>((entry) => {
    switch (entry.kind) {
      case "user":
        return [{ id: nextItemId(), kind: "user", text: entry.text }];
      case "assistant":
        return [{ id: nextItemId(), kind: "assistant", text: entry.text }];
      case "thinking":
        return [{ id: nextItemId(), kind: "thinking", text: entry.text }];
      case "tool":
        return [
          {
            id: nextItemId(),
            kind: "tool",
            name: entry.name,
            summary: entry.summary,
            text: entry.text,
            isError: entry.isError,
            running: false,
          },
        ];
      default:
        return [];
    }
  });
}
