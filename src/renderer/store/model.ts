/**
 * The model catalogue, shared by the composer and the models page.
 *
 * Both read the same pi configuration but in different shapes: the page edits
 * providers in `models.json`, the composer offers whatever came back as
 * available models. Keeping them in one store is what makes a write on one page
 * show up in the other without a reload or an app restart.
 *
 * Writes go through `agent()` and then re-read the same snapshot the page and
 * the composer both use, so the store never mirrors a handler's return shape.
 */
import { useEffect } from "react";
import { create } from "zustand";
import { agent, type ModelInfo, type ProviderSummary } from "../lib/agent";

export type ModelRef = {
  provider: string;
  id: string;
};

const NO_MODELS: ModelInfo[] = [];
const NO_PROVIDERS: ProviderSummary[] = [];

export type ModelState = {
  /** `models.json` as the models page shows it. */
  providers: ProviderSummary[];
  /** What the composer may switch to (providers with credentials). */
  available: ModelInfo[];
  defaultModel: ModelRef | null;
  /** pi's default; what a conversation without its own level runs with. */
  defaultThinkingLevel: string;
  loaded: boolean;
  /** `force` re-reads the file; the default skips a load already done. */
  load: (force?: boolean) => Promise<void>;
  setDefaultModel: (provider: string, id: string) => Promise<void>;
  saveProvider: (id: string, input: { baseUrl: string; api: string; apiKey?: string }) => Promise<void>;
  removeProvider: (id: string) => Promise<void>;
  addModel: (
    providerId: string,
    model: { id: string; name?: string; contextWindow?: number },
  ) => Promise<void>;
  removeModel: (providerId: string, modelId: string) => Promise<void>;
};

export const useModel = create<ModelState>((set, get) => {
  /**
   * A write only means "the file changed"; read the snapshot again rather than
   * trusting whatever shape the mutation handler happened to return.
   */
  const write = async (action: () => Promise<unknown>): Promise<void> => {
    await action();
    await get().load(true);
  };

  return {
    providers: NO_PROVIDERS,
    available: NO_MODELS,
    defaultModel: null,
    defaultThinkingLevel: "",
    loaded: false,

    load: async (force = false) => {
      if (!force && get().loaded) return;
      const [providers, available, defaultModel, defaultThinkingLevel] = await Promise.all([
        agent().modelsList(),
        agent().models(),
        agent().defaultModel(),
        agent().defaultThinkingLevel(),
      ]);
      set({ providers, available, defaultModel, defaultThinkingLevel, loaded: true });
    },

    setDefaultModel: async (provider, id) => {
      set({ defaultModel: await agent().setDefaultModel(provider, id) });
    },

    saveProvider: (id, input) => write(() => agent().saveProvider(id, input)),
    removeProvider: (id) => write(() => agent().removeProvider(id)),
    addModel: (providerId, model) => write(() => agent().addModel(providerId, model)),
    removeModel: (providerId, modelId) => write(() => agent().removeModel(providerId, modelId)),
  };
});

/** Imperative access from event handlers. */
export const getModel = useModel.getState;

/**
 * Mount where the catalogue is used. `force` is for the models page, which
 * should show what is on disk rather than a catalogue loaded hours ago; the
 * composer only needs the data once.
 */
export function useModelSync(force = false): void {
  useEffect(() => {
    void getModel()
      .load(force)
      .catch(() => undefined);
  }, [force]);
}
