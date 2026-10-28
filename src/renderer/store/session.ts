/**
 * The conversation list. Server data (IPC), so one store shared by the sidebar
 * and the composer instead of each of them fetching it.
 */
import { create } from "zustand";
import { agent, type SessionSummary } from "../lib/agent";
import { useAgentStream } from "./agent-stream";
import { getTranscript } from "./transcript";

const NO_SESSIONS: SessionSummary[] = [];

export type SessionState = {
  list: SessionSummary[];
  loading: boolean;
  /** Re-read the list; a call while one is in flight is a no-op. */
  refresh: () => Promise<SessionSummary[]>;
};

export const useSession = create<SessionState>((set, get) => ({
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
        if (getTranscript().getBusy(entry.id) !== working) getTranscript().setBusy(entry.id, working);
      }
      set({ list });
      return get().list;
    } finally {
      set({ loading: false });
    }
  },
}));

/** Imperative access from event handlers and other stores. */
export const getSession = useSession.getState;

/** A turn ending and a worker coming up are the two moments the list changes. */
function startSessionsSync(): () => void {
  void getSession().refresh();
  return agent().onEvent((event) => {
    if (event.type === "settled" || event.type === "ready") void getSession().refresh();
  });
}

export function useSessionSync(): void {
  useAgentStream(startSessionsSync);
}
