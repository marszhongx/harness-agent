/**
 * Model connectivity checks for the Models page.
 *
 * Results live here so closing the dialog or switching pages does not throw
 * them away. They are UI state only: nothing is persisted, and the model
 * catalogue never gates on them.
 */
import { create } from "zustand";
import { agent, type ModelProbe } from "../lib/agent";

export const probeKey = (provider: string, model: string) => `${provider}/${model}`;

export type ProbeState = {
  /** provider/model -> the last result. */
  results: Map<string, ModelProbe>;
  /** provider/model in the active run (queued, current, or just completed). */
  running: Set<string>;
  /** provider/model actually being tested right now. */
  current: Set<string>;
  /** Run the selected models one at a time; overlapping keys are ignored. */
  run: (provider: string, models: string[]) => Promise<void>;
  /** Drop the results of a provider that no longer exists. */
  forget: (provider: string) => void;
  /** Drop the result of one model that was removed. */
  forgetModel: (provider: string, model: string) => void;
};

export const useProbe = create<ProbeState>((set, get) => ({
  results: new Map(),
  running: new Set(),
  current: new Set(),

  run: async (provider, models) => {
    if (models.length === 0) return;
    const keys = models.map((model) => probeKey(provider, model));
    if (keys.some((key) => get().running.has(key))) return;

    set((state) => {
      // Clear the selected rows; they stay listed, but only the current one
      // shows the loading icon.
      const results = new Map(state.results);
      for (const key of keys) results.delete(key);
      return { results, running: new Set([...state.running, ...keys]) };
    });
    for (const [index, model] of models.entries()) {
      const key = keys[index];
      set((state) => {
        const current = new Set(state.current);
        current.add(key);
        return { current };
      });
      let result: ModelProbe;
      try {
        result = await agent().testModel(provider, model);
      } catch (cause) {
        result = { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
      }
      set((state) => {
        const results = new Map(state.results);
        results.set(key, result);
        const current = new Set(state.current);
        current.delete(key);
        return { results, current };
      });
    }
    set((state) => {
      const running = new Set(state.running);
      for (const key of keys) running.delete(key);
      return { running };
    });
  },

  forget: (provider) =>
    set((state) => {
      const prefix = `${provider}/`;
      return {
        results: new Map([...state.results].filter(([key]) => !key.startsWith(prefix))),
        running: new Set([...state.running].filter((key) => !key.startsWith(prefix))),
        current: new Set([...state.current].filter((key) => !key.startsWith(prefix))),
      };
    }),

  forgetModel: (provider, model) => {
    const key = probeKey(provider, model);
    set((state) => {
      const results = new Map(state.results);
      const running = new Set(state.running);
      const current = new Set(state.current);
      results.delete(key);
      running.delete(key);
      current.delete(key);
      return { results, running, current };
    });
  },
}));

/** Imperative access from event handlers. */
export const getProbe = useProbe.getState;
