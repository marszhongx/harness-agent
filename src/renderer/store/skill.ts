/**
 * Skills as the app sees them.
 *
 * The list is read from the same directories pi scans, and the skills page is
 * its only consumer today. It lives in a store anyway: a delete re-reads the
 * directories into the shared copy, and remounting the page does not require
 * every consumer to keep its own duplicate of the list. `useSkillSync`
 * re-reads on mount, so an edit made outside the app still shows up next time
 * the page is opened.
 */
import { useEffect } from "react";
import { create } from "zustand";
import { agent, type SkillSummary } from "../lib/agent";

const NO_SKILLS: SkillSummary[] = [];

export type SkillState = {
  list: SkillSummary[];
  loading: boolean;
  load: (sessionId?: string | null) => Promise<void>;
  remove: (dir: string, sessionId?: string | null) => Promise<void>;
};

export const useSkill = create<SkillState>((set, get) => ({
  list: NO_SKILLS,
  loading: false,

  load: async (sessionId) => {
    set({ loading: true });
    try {
      set({ list: await agent().skillsList(sessionId) });
    } finally {
      set({ loading: false });
    }
  },

  remove: async (dir, sessionId) => {
    await agent().removeSkill(dir, sessionId);
    // Re-read the directory rather than removing the row by hand: the next
    // scan is also what pi will see when the worker restarts.
    await get().load(sessionId);
  },
}));

/** Imperative access from event handlers. */
export const getSkill = useSkill.getState;

export function useSkillSync(sessionId?: string | null): void {
  useEffect(() => {
    void getSkill()
      .load(sessionId)
      .catch(() => undefined);
  }, [sessionId]);
}
