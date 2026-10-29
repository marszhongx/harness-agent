/**
 * `models.json`: the provider catalogue pi reads at startup.
 *
 * This is the only place pi accepts a new provider, and it does not reload at
 * runtime — so every successful edit has to be followed by a worker restart.
 *
 * Reads and writes whole-file and preserves whatever else is in there (unknown
 * keys, per-model extras): the file belongs to the user and to the pi CLI, and
 * this app is a second writer, not the owner. Writes keep the previous version
 * as `models.json.bak` and go through tmp+rename.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { agentDir } from "./pi-settings.ts";
import type { ModelInfo } from "./protocol.ts";

export interface ModelEntry {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  /** pi's per-level mapping: a level mapped to `null` is not available. */
  thinkingLevelMap?: Record<string, string | null>;
  [key: string]: unknown;
}

export interface ProviderEntry {
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  compat?: unknown;
  models?: ModelEntry[];
  [key: string]: unknown;
}

export interface ModelsConfig {
  providers?: Record<string, ProviderEntry>;
  [key: string]: unknown;
}

/** What the UI needs, with the key reduced to "is one set". */
export interface ProviderSummary {
  id: string;
  baseUrl: string;
  api: string;
  hasKey: boolean;
  models: Array<{
    id: string;
    name: string;
    contextWindow?: number;
    reasoning?: boolean;
    thinkingLevelMap?: Record<string, string | null>;
  }>;
}

export function modelsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(agentDir(env), "models.json");
}

export function readModelsConfig(env: NodeJS.ProcessEnv = process.env): ModelsConfig {
  try {
    const parsed = JSON.parse(readFileSync(modelsPath(env), "utf8")) as unknown;
    if (parsed && typeof parsed === "object") return parsed as ModelsConfig;
  } catch {
    // Missing or unparsable: start from an empty catalogue rather than throwing
    // at the caller; writeModelsConfig will replace the file.
  }
  return { providers: {} };
}

export function summarize(config: ModelsConfig): ProviderSummary[] {
  return Object.entries(config.providers ?? {}).map(([id, provider]) => ({
    id,
    baseUrl: String(provider?.baseUrl ?? ""),
    api: String(provider?.api ?? ""),
    hasKey: typeof provider?.apiKey === "string" && provider.apiKey.length > 0,
    models: (provider?.models ?? []).map((model) => ({
      id: String(model?.id ?? ""),
      name: String(model?.name ?? model?.id ?? ""),
      contextWindow: typeof model?.contextWindow === "number" ? model.contextWindow : undefined,
      reasoning: model?.reasoning === true,
      thinkingLevelMap: model?.thinkingLevelMap,
    })),
  }));
}

export function listProviders(env: NodeJS.ProcessEnv = process.env): ProviderSummary[] {
  return summarize(readModelsConfig(env));
}

/** A model the agent can be switched to, in the shape the UI wants. */
export type AvailableModel = ModelInfo;

/**
 * The model catalogue, computed instead of asked for.
 *
 * pi can list its own available models, but only from a running process; asking
 * it for the list used to mean keeping a pi process alive just to fill a
 * dropdown. The rule pi applies is "the provider has credentials", and that is
 * `apiKey` being set here, so the same list can be derived from the file.
 */
export function availableModels(env: NodeJS.ProcessEnv = process.env): AvailableModel[] {
  return listProviders(env)
    .filter((provider) => provider.hasKey)
    .flatMap((provider) =>
      provider.models.map((model) => ({
        provider: provider.id,
        id: model.id,
        name: model.name || model.id,
        contextWindow: model.contextWindow,
        reasoning: model.reasoning === true,
        thinkingLevelMap: model.thinkingLevelMap,
      })),
    );
}

export interface ProviderInput {
  baseUrl: string;
  api: string;
  /** Omitted or empty keeps the existing key. */
  apiKey?: string;
}

export function upsertProvider(
  id: string,
  input: ProviderInput,
  env: NodeJS.ProcessEnv = process.env,
): ProviderSummary[] {
  const name = id.trim();
  if (!name) throw new Error("provider id 不能为空");
  const config = readModelsConfig(env);
  config.providers ??= {};
  const existing = config.providers[name] ?? {};
  const next: ProviderEntry = {
    ...existing,
    baseUrl: input.baseUrl.trim(),
    api: input.api.trim() || existing.api || "openai-completions",
    models: existing.models ?? [],
  };
  if (input.apiKey !== undefined && input.apiKey !== "") next.apiKey = input.apiKey;
  config.providers[name] = next;
  writeModelsConfig(config, env);
  return summarize(config);
}

export function removeProvider(id: string, env: NodeJS.ProcessEnv = process.env): ProviderSummary[] {
  const config = readModelsConfig(env);
  if (config.providers?.[id]) {
    delete config.providers[id];
    writeModelsConfig(config, env);
  }
  return summarize(config);
}

export function addModel(
  providerId: string,
  model: { id: string; name?: string; contextWindow?: number },
  env: NodeJS.ProcessEnv = process.env,
): ProviderSummary[] {
  const modelId = model.id.trim();
  if (!modelId) throw new Error("model id 不能为空");
  const config = readModelsConfig(env);
  const provider = config.providers?.[providerId];
  if (!provider) throw new Error(`provider ${providerId} 不存在`);
  provider.models ??= [];
  const existing = provider.models.find((entry) => entry?.id === modelId);
  if (existing) {
    existing.name = model.name?.trim() || existing.name || modelId;
    if (model.contextWindow) existing.contextWindow = model.contextWindow;
  } else {
    provider.models.push({
      id: modelId,
      name: model.name?.trim() || modelId,
      contextWindow: model.contextWindow,
    });
  }
  writeModelsConfig(config, env);
  return summarize(config);
}

export function removeModel(
  providerId: string,
  modelId: string,
  env: NodeJS.ProcessEnv = process.env,
): ProviderSummary[] {
  const config = readModelsConfig(env);
  const provider = config.providers?.[providerId];
  if (provider?.models) {
    provider.models = provider.models.filter((entry) => entry?.id !== modelId);
    writeModelsConfig(config, env);
  }
  return summarize(config);
}

function writeModelsConfig(config: ModelsConfig, env: NodeJS.ProcessEnv): void {
  const path = modelsPath(env);
  const directory = dirname(path);
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
  if (existsSync(path)) {
    try {
      copyFileSync(path, `${path}.bak`);
    } catch {
      // Nothing to preserve.
    }
  }
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`);
  renameSync(temporary, path);
}
