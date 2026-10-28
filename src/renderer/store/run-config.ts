/**
 * What each conversation is running with.
 *
 * The catalogue and its default model live in `store/model.ts`; this store is
 * only the per-conversation choices, keyed by session id ("" is the
 * new-conversation page). Keeping the two apart means editing a provider does
 * not touch a conversation, and a model pick does not rewrite the catalogue.
 */
import { useEffect } from "react";
import { create } from "zustand";
import { agent } from "../lib/agent";
import { useAgentStream } from "./agent-stream";
import { type ModelRef, useModel } from "./model";
import { useSession, useSessionSync } from "./session";

const DRAFT = "";

export type ThinkingState = {
  level: string | null;
  levels: string[];
};

const NO_THINKING: ThinkingState = { level: null, levels: [] };

function put<K, V>(map: Map<K, V>, key: K, value: V): Map<K, V> {
  const next = new Map(map);
  next.set(key, value);
  return next;
}

export type RunConfigState = {
  /** Chosen model per conversation; falls back to the conversation's own, then the default. */
  chosen: Map<string, ModelRef>;
  thinking: Map<string, ThinkingState>;
  workspace: Map<string, string | null>;
  getThinking: (sessionId: string | null) => ThinkingState;
  getWorkspace: (sessionId: string | null) => string | null;
  chooseModel: (sessionId: string | null, provider: string, id: string) => void;
  chooseThinking: (sessionId: string | null, level: string) => void;
  /** Read the workspace for one conversation. */
  sync: (sessionId: string | null) => Promise<void>;
  record: (sessionId: string, model?: ModelRef, thinking?: ThinkingState) => void;
};

export const useRunConfig = create<RunConfigState>((set, get) => {
  const key = (sessionId: string | null) => sessionId ?? DRAFT;

  const setThinking = (sessionId: string | null, thinking: ThinkingState) =>
    set({ thinking: put(get().thinking, key(sessionId), thinking) });

  return {
    chosen: new Map(),
    thinking: new Map(),
    workspace: new Map(),

    getThinking: (sessionId) => get().thinking.get(key(sessionId)) ?? NO_THINKING,
    getWorkspace: (sessionId) => get().workspace.get(key(sessionId)) ?? null,

    // `null` is the new-conversation page: main remembers the pick and applies it
    // when the first message mints the session.
    chooseModel: (sessionId, provider, id) => {
      void agent().setModel(sessionId, provider, id);
      set({ chosen: put(get().chosen, key(sessionId), { provider, id }) });
    },

    chooseThinking: (sessionId, level) => {
      void agent().setThinkingLevel(sessionId, level);
      setThinking(sessionId, { level, levels: (get().thinking.get(key(sessionId)) ?? NO_THINKING).levels });
    },

    sync: async (sessionId) => {
      const status = await agent().status(sessionId ?? undefined);
      set({ workspace: put(get().workspace, key(sessionId), status.workspacePath) });
    },

    record: (sessionId, model, thinking) => {
      if (model) set({ chosen: put(get().chosen, sessionId, model) });
      if (thinking) setThinking(sessionId, thinking);
    },
  };
});

/** Imperative access from event handlers. */
export const getRunConfig = useRunConfig.getState;

/** pi reports the model and thinking level it ended up with; fold them in. */
function startRunConfigSync(): () => void {
  return agent().onEvent((event) => {
    const sessionId = typeof event.sessionId === "string" ? event.sessionId : "";
    if (!sessionId) return;
    if (event.type === "model") {
      getRunConfig().record(sessionId, { provider: String(event.provider), id: String(event.id) });
    } else if (event.type === "thinking") {
      const levels =
        Array.isArray(event.levels) && event.levels.length > 0
          ? (event.levels as string[])
          : (getRunConfig().thinking.get(sessionId)?.levels ?? []);
      getRunConfig().record(sessionId, undefined, {
        level:
          typeof event.level === "string"
            ? event.level
            : (getRunConfig().thinking.get(sessionId)?.level ?? null),
        levels,
      });
    }
  });
}

/**
 * The event stream alone: mount it once, at the shell, so model/thinking
 * reports from background conversations are not dropped with a page.
 */
export function useRunConfigEvents(): void {
  useAgentStream(startRunConfigSync);
}

/**
 * The catalogue and workspace for the conversation on screen. Kept apart from
 * the event stream because it is keyed by session and belongs where the session
 * is displayed.
 */
export function useRunConfigSync(sessionId: string | null): void {
  useRunConfigEvents();
  useEffect(() => {
    void getRunConfig().sync(sessionId);
  }, [sessionId]);
}

/**
 * The thinking level a conversation runs with: what pi reported for it, else what
 * `sessions.json` recorded when it last ran, else pi's default. Without the last
 * two the chip is blank until a worker starts.
 */
export function useCurrentThinking(sessionId: string | null): {
  level: string | null;
  levels: string[];
} {
  const reported = useRunConfig((state) => state.thinking.get(sessionId ?? DRAFT));
  const fallback = useModel((state) => state.defaultThinkingLevel);
  useSessionSync();
  const list = useSession((state) => state.list);
  const entry = sessionId ? list.find((item) => item.id === sessionId) : undefined;
  return {
    level: reported?.level ?? entry?.thinkingLevel ?? (fallback || null),
    levels: reported?.levels ?? [],
  };
}

/** The model a conversation runs with: its pick, its own record, or the default. */
export function useCurrentModel(sessionId: string | null): ModelRef | null {
  const chosen = useRunConfig((state) => state.chosen.get(sessionId ?? DRAFT));
  const defaultModel = useModel((state) => state.defaultModel);
  useSessionSync();
  const list = useSession((state) => state.list);
  const entry = sessionId ? list.find((item) => item.id === sessionId) : undefined;
  return chosen ?? entry?.model ?? defaultModel;
}
