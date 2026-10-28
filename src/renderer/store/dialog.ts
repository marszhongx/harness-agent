/**
 * Dialogs pi is blocked on, kept per conversation instead of per page.
 *
 * A dialog is a request from a worker that will not continue until it is
 * answered. The chat page is only one view of the app: the user may be looking
 * at settings, or at another conversation, when the request arrives. Keeping
 * the queue here lets the request survive that (and lets a background turn ask
 * its question without hijacking the foreground transcript).
 *
 * The renderer id is minted by the main process and is unique across workers;
 * the worker's own `d1`, `d2`, ... restart in every process and cannot be used
 * as a key across conversations.
 */
import { create } from "zustand";
import { agent, type DialogRequest, type UiAnswer } from "../lib/agent";
import { useAgentStream } from "./agent-stream";

export interface PendingDialog {
  sessionId: string;
  requestId: string;
  request: DialogRequest;
}

const NO_DIALOG: PendingDialog | null = null;

/** Remove one request from whichever conversation's queue holds it. */
function without(queue: Map<string, PendingDialog[]>, requestId: string): Map<string, PendingDialog[]> {
  const next = new Map(queue);
  for (const [sessionId, list] of next) {
    if (!list.some((entry) => entry.requestId === requestId)) continue;
    const kept = list.filter((entry) => entry.requestId !== requestId);
    if (kept.length === 0) next.delete(sessionId);
    else next.set(sessionId, kept);
  }
  return next;
}

export type DialogState = {
  /** One queue per conversation; the first entry is the one on screen. */
  queue: Map<string, PendingDialog[]>;
  getFor: (sessionId: string | null) => PendingDialog | null;
  push: (dialog: PendingDialog) => void;
  /** Answer it and take it off the screen. */
  answer: (dialog: PendingDialog, value: UiAnswer) => void;
  cancel: (requestId: string) => void;
  dropSession: (sessionId: string) => void;
};

export const useDialog = create<DialogState>((set, get) => ({
  queue: new Map(),

  getFor: (sessionId) => get().queue.get(sessionId ?? "")?.[0] ?? NO_DIALOG,

  push: (dialog) =>
    set((state) => {
      // A reloaded window can be told about the same request twice; a dialog
      // that is already queued must not be shown twice.
      for (const list of state.queue.values()) {
        if (list.some((entry) => entry.requestId === dialog.requestId)) return state;
      }
      const next = new Map(state.queue);
      next.set(dialog.sessionId, [...(next.get(dialog.sessionId) ?? []), dialog]);
      return { queue: next };
    }),

  answer: (dialog, value) => {
    // Take it down before the IPC round trip: the run may settle while the
    // answer is in flight, and a late settle must not bring the card back.
    set({ queue: without(get().queue, dialog.requestId) });
    void agent().answer(dialog.requestId, value);
  },

  cancel: (requestId) => set({ queue: without(get().queue, requestId) }),

  dropSession: (sessionId) =>
    set((state) => {
      if (!state.queue.has(sessionId)) return state;
      const next = new Map(state.queue);
      next.delete(sessionId);
      return { queue: next };
    }),
}));

/** Imperative access from event handlers. */
export const getDialog = useDialog.getState;

/**
 * Main closes dialogs the worker can no longer receive an answer for (turn
 * ended, worker replaced, window closed). The renderer follows, so a card never
 * outlives the request it belongs to.
 */
function startDialogsSync(): () => void {
  const stopDialog = agent().onDialog(({ sessionId, requestId, dialog }) => {
    // No conversation means no worker, and a dialog always belongs to one.
    if (!sessionId) return;
    getDialog().push({ sessionId, requestId, request: dialog });
  });
  const stopEvents = agent().onEvent((event) => {
    if (event.type !== "dialog_cancelled") return;
    const requestId = typeof event.requestId === "string" ? event.requestId : "";
    if (requestId) {
      getDialog().cancel(requestId);
      return;
    }
    const sessionId = typeof event.sessionId === "string" ? event.sessionId : "";
    if (sessionId) getDialog().dropSession(sessionId);
  });
  return () => {
    stopDialog();
    stopEvents();
  };
}

export function useDialogSync(): void {
  useAgentStream(startDialogsSync);
}
