/**
 * The conversation list. Server data (IPC), so one store shared by the sidebar
 * and the composer instead of each of them fetching it.
 */
import { create } from "zustand";
import { agent, type SessionSummary } from "../lib/agent";
import { useAgentStream } from "./agent-stream";
import { getTranscripts } from "./transcript";

const NO_SESSIONS: SessionSummary[] = [];

export type SessionsState = {
  list: SessionSummary[];
  loading: boolean;
  /** Re-read the list; a call while one is in flight is a no-op. */
  refresh: () => Promise<SessionSummary[]>;
};

export const useSessions = create<SessionsState>((set, get) => ({
  list: NO_SESSIONS,
  loading: false,

  refresh: async () => {
    if (get().loading) return get().list;
    set({ loading: true });
    try {
      const list = await agent().listSessions();
      // The list is the authority on "is a turn running": a window that just
      // reloaded has no event history, and would otherwise show every row idle.
      for (const entry of list) {
        const working = entry.working === true;
        if (getTranscripts().getBusy(entry.id) !== working) getTranscripts().setBusy(entry.id, working);
      }
      set({ list });
      return get().list;
    } finally {
      set({ loading: false });
    }
  },
}));

/** Imperative access from event handlers and other stores. */
export const getSessions = useSessions.getState;

/** A turn ending and a worker coming up are the two moments the list changes. */
function startSessionsSync(): () => void {
  void getSessions().refresh();
  return agent().onEvent((event) => {
    if (event.type === "settled" || event.type === "ready") void getSessions().refresh();
  });
}

export function useSessionsSync(): void {
  useAgentStream(startSessionsSync);
}
