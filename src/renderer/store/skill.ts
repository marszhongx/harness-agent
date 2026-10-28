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
  load: () => Promise<void>;
  remove: (dir: string) => Promise<void>;
};

export const useSkill = create<SkillState>((set, get) => ({
  list: NO_SKILLS,
  loading: false,

  load: async () => {
    set({ loading: true });
    try {
      set({ list: await agent().skillsList() });
    } finally {
      set({ loading: false });
    }
  },

  remove: async (dir) => {
    await agent().removeSkill(dir);
    // The list is what pi would discover now, not the old list minus one row:
    // removing a project skill can reveal a user skill with the same name.
    await get().load();
  },
}));

/** Imperative access from event handlers. */
export const getSkill = useSkill.getState;

export function useSkillSync(): void {
  useEffect(() => {
    void getSkill()
      .load()
      .catch(() => undefined);
  }, []);
}
