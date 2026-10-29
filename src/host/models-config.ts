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

function authPath(env: NodeJS.ProcessEnv): string {
  return join(agentDir(env), "auth.json");
}

/**
 * Provider ids with a stored credential in `auth.json`.
 *
 * Pi resolves credentials before `models.json`, so a provider can be usable
 * even when its `models.json` entry has no `apiKey`. The app only needs to know
 * that a credential exists; it never reads the secret.
 */
function storedCredentialProviders(env: NodeJS.ProcessEnv): Set<string> {
  try {
    const parsed = JSON.parse(readFileSync(authPath(env), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return new Set();
    return new Set(
      Object.entries(parsed)
        .filter(([, value]) => value !== null && typeof value === "object")
        .map(([id]) => id),
    );
  } catch {
    return new Set();
  }
}

/** Pi's primary environment variable for providers with a standard name. */
const PROVIDER_ENV_KEYS: Record<string, string[]> = {
  anthropic: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN"],
  azure: ["AZURE_OPENAI_API_KEY"],
  google: ["GEMINI_API_KEY"],
  "github-copilot": ["COPILOT_GITHUB_TOKEN"],
  huggingface: ["HF_TOKEN"],
  "kimi-coding": ["KIMI_API_KEY"],
  "moonshotai-cn": ["MOONSHOT_API_KEY"],
  moonshotai: ["MOONSHOT_API_KEY"],
  "qwen-token-plan-individual": ["QWEN_TOKEN_PLAN_API_KEY"],
  "vercel-ai-gateway": ["AI_GATEWAY_API_KEY"],
};

function providerEnvKeys(id: string): string[] {
  return PROVIDER_ENV_KEYS[id] ?? [`${id.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`];
}

/** Literal, `$NAME`/`${NAME}` interpolation, or a `!command`; empty means unset. */
function hasConfiguredApiKey(value: unknown, env: NodeJS.ProcessEnv): boolean {
  if (typeof value !== "string") return false;
  const key = value.trim();
  if (!key) return false;
  if (!key.startsWith("$")) return true;
  const name = key.startsWith("${") && key.endsWith("}") ? key.slice(2, -1) : key.slice(1);
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && Boolean(env[name]?.trim());
}

function hasCredential(
  id: string,
  provider: ProviderEntry | undefined,
  env: NodeJS.ProcessEnv,
  stored: Set<string>,
): boolean {
  return (
    stored.has(id) ||
    hasConfiguredApiKey(provider?.apiKey, env) ||
    providerEnvKeys(id).some((name) => Boolean(env[name]?.trim()))
  );
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

export function summarize(
  config: ModelsConfig,
  env: NodeJS.ProcessEnv = process.env,
  stored = storedCredentialProviders(env),
): ProviderSummary[] {
  return Object.entries(config.providers ?? {}).map(([id, provider]) => ({
    id,
    baseUrl: String(provider?.baseUrl ?? ""),
    api: String(provider?.api ?? ""),
    hasKey: hasCredential(id, provider, env, stored),
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
  return summarize(readModelsConfig(env), env);
}

/** A model the agent can be switched to, in the shape the UI wants. */
export type AvailableModel = ModelInfo;

/**
 * The model catalogue, computed instead of asked for.
 *
 * pi can list its own available models, but only from a running process; asking
 * it for the list used to mean keeping a pi process alive just to fill a
 * dropdown. The rule pi applies is "the provider has credentials"; this reads
 * the same sources it does (`auth.json`, `models.json`, provider env vars)
 * without keeping a process alive just to fill a dropdown.
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
  return summarize(config, env);
}

export function removeProvider(id: string, env: NodeJS.ProcessEnv = process.env): ProviderSummary[] {
  const config = readModelsConfig(env);
  if (config.providers?.[id]) {
    delete config.providers[id];
    writeModelsConfig(config, env);
  }
  return summarize(config, env);
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
  return summarize(config, env);
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
  return summarize(config, env);
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
