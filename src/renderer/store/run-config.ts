/**
 * Run settings: which models exist, and what each conversation is running with.
 *
 * One store, keyed by session id ("" is the new-conversation page). The
 * catalogue and the per-conversation picks have different lifetimes but the same
 * consumers, and keying them keeps a model change in one conversation from
 * touching another.
 */
import { useEffect } from "react";
import { create } from "zustand";
import { agent, type ModelInfo } from "../lib/agent";
import { useAgentStream } from "./agent-stream";
import { useSessions, useSessionsSync } from "./sessions";

const DRAFT = "";

export type ModelRef = {
  provider: string;
  id: string;
};

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
  models: ModelInfo[];
  defaultModel: ModelRef | null;
  /** What pi uses when a conversation has no level of its own. */
  defaultThinkingLevel: string;
  /** Chosen model per conversation; falls back to the conversation's own, then the default. */
  chosen: Map<string, ModelRef>;
  thinking: Map<string, ThinkingState>;
  workspace: Map<string, string | null>;
  getThinking: (sessionId: string | null) => ThinkingState;
  getWorkspace: (sessionId: string | null) => string | null;
  loadCatalog: () => Promise<void>;
  setDefaultModel: (provider: string, id: string) => Promise<void>;
  chooseModel: (sessionId: string | null, provider: string, id: string) => void;
  chooseThinking: (sessionId: string | null, level: string) => void;
  /** Read the workspace (and the catalogue) for one conversation. */
  sync: (sessionId: string | null) => Promise<void>;
  record: (sessionId: string, model?: ModelRef, thinking?: ThinkingState) => void;
};

export const useRunConfig = create<RunConfigState>((set, get) => {
  const key = (sessionId: string | null) => sessionId ?? DRAFT;

  const setThinking = (sessionId: string | null, thinking: ThinkingState) =>
    set({ thinking: put(get().thinking, key(sessionId), thinking) });

  return {
    models: [],
    defaultModel: null,
    defaultThinkingLevel: "", // replaced on first loadCatalog
    chosen: new Map(),
    thinking: new Map(),
    workspace: new Map(),

    getThinking: (sessionId) => get().thinking.get(key(sessionId)) ?? NO_THINKING,
    getWorkspace: (sessionId) => get().workspace.get(key(sessionId)) ?? null,

    loadCatalog: async () => {
      if (get().models.length > 0) return;
      const [models, defaultModel, defaultThinkingLevel] = await Promise.all([
        agent().models(),
        agent().defaultModel(),
        agent().defaultThinkingLevel(),
      ]);
      set({ models, defaultModel, defaultThinkingLevel });
    },

    setDefaultModel: async (provider, id) => {
      set({ defaultModel: await agent().setDefaultModel(provider, id) });
    },

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
      const [, status] = await Promise.all([get().loadCatalog(), agent().status(sessionId ?? undefined)]);
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

export function useRunConfigSync(sessionId: string | null): void {
  useAgentStream(startRunConfigSync);
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
  const fallback = useRunConfig((state) => state.defaultThinkingLevel);
  useSessionsSync();
  const list = useSessions((state) => state.list);
  const entry = sessionId ? list.find((item) => item.id === sessionId) : undefined;
  return {
    level: reported?.level ?? entry?.thinkingLevel ?? (fallback || null),
    levels: reported?.levels ?? [],
  };
}

/** The model a conversation runs with: its pick, its own record, or the default. */
export function useCurrentModel(sessionId: string | null): ModelRef | null {
  const chosen = useRunConfig((state) => state.chosen.get(sessionId ?? DRAFT));
  const defaultModel = useRunConfig((state) => state.defaultModel);
  useSessionsSync();
  const list = useSessions((state) => state.list);
  const entry = sessionId ? list.find((item) => item.id === sessionId) : undefined;
  return chosen ?? entry?.model ?? defaultModel;
}
