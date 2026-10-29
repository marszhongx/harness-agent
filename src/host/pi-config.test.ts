import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  addModel,
  availableModels,
  listProviders,
  modelsPath,
  readModelsConfig,
  removeModel,
  removeProvider,
  upsertProvider,
} from "./models-config.ts";
import {
  agentDir,
  moveLegacyAgentDir,
  readDefaultModel,
  restoreDefaultSkills,
  seedAgentDir,
  settingsPath,
  writeDefaultModel,
} from "./pi-settings.ts";

/** These modules read pi's config through an overridable agent directory. */
let dir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-config-"));
  env = { PI_CODING_AGENT_DIR: dir };
});

describe("agentDir", () => {
  it("honours PI_CODING_AGENT_DIR and falls back to ~/.pi/agent", () => {
    expect(agentDir({ PI_CODING_AGENT_DIR: "/tmp/x" })).toBe("/tmp/x");
    expect(agentDir({})).toBe(join(homedir(), ".pi", "agent"));
  });

  it("expands a leading tilde", () => {
    expect(agentDir({ PI_CODING_AGENT_DIR: "~/somewhere" })).toBe(join(homedir(), "somewhere"));
  });
});

describe("app-owned pi agent directory", () => {
  it("copies the legacy files once", () => {
    const legacy = join(dir, "legacy");
    const local = join(dir, "local");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "models.json"), '{"providers":{}}');
    writeFileSync(join(legacy, "auth.json"), '{"hifox":{"type":"api_key","key":"x"}}');
    writeFileSync(join(legacy, "settings.json"), '{"defaultModel":"m"}');
    writeFileSync(join(legacy, "trust.json"), '{"project":true}');
    mkdirSync(join(legacy, "skills", "pdf-tools"), { recursive: true });
    writeFileSync(join(legacy, "skills", "pdf-tools", "SKILL.md"), "---\nname: pdf\ndescription: x\n---\n");

    seedAgentDir(local, legacy);

    expect(readFileSync(join(local, "models.json"), "utf8")).toBe('{"providers":{}}');
    expect(readFileSync(join(local, "auth.json"), "utf8")).toContain("hifox");
    expect(readFileSync(join(local, "settings.json"), "utf8")).toContain("defaultModel");
    expect(readFileSync(join(local, "trust.json"), "utf8")).toContain("project");
    expect(readFileSync(join(local, "skills", "pdf-tools", "SKILL.md"), "utf8")).toContain("name: pdf");
    expect(existsSync(join(local, ".seeded"))).toBe(true);
  });

  it("does not overwrite an existing local file or re-import after the marker", () => {
    const legacy = join(dir, "legacy");
    const local = join(dir, "local");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "models.json"), "legacy");
    mkdirSync(local, { recursive: true });
    writeFileSync(join(local, "models.json"), "local");

    seedAgentDir(local, legacy);
    expect(readFileSync(join(local, "models.json"), "utf8")).toBe("local");

    writeFileSync(join(legacy, "models.json"), "legacy changed");
    seedAgentDir(local, legacy);
    expect(readFileSync(join(local, "models.json"), "utf8")).toBe("local");
  });
});

describe("app agent directory migration", () => {
  it("moves the old pi directory to .pi once", () => {
    const previous = join(dir, "pi");
    const target = join(dir, ".pi");
    mkdirSync(previous, { recursive: true });
    writeFileSync(join(previous, "models.json"), "old");

    moveLegacyAgentDir(target, previous);

    expect(existsSync(previous)).toBe(false);
    expect(readFileSync(join(target, "models.json"), "utf8")).toBe("old");
  });

  it("does not overwrite an existing target", () => {
    const previous = join(dir, "pi");
    const target = join(dir, ".pi");
    mkdirSync(previous, { recursive: true });
    mkdirSync(target, { recursive: true });
    writeFileSync(join(previous, "models.json"), "old");
    writeFileSync(join(target, "models.json"), "new");

    moveLegacyAgentDir(target, previous);

    expect(readFileSync(join(target, "models.json"), "utf8")).toBe("new");
    expect(existsSync(previous)).toBe(true);
  });
});

describe("app default skill policy", () => {
  it("removes only the app-generated skill exclusion", () => {
    const generated = `!${join(homedir(), ".agents", "skills")}/**`;
    writeFileSync(settingsPath(env), JSON.stringify({ theme: "dark", skills: [generated] }));

    restoreDefaultSkills(env);

    expect(JSON.parse(readFileSync(settingsPath(env), "utf8"))).toEqual({ theme: "dark" });
    expect(existsSync(`${settingsPath(env)}.bak`)).toBe(true);
  });

  it("leaves a user-owned skill exclusion alone", () => {
    writeFileSync(settingsPath(env), JSON.stringify({ skills: ["!my-own-skill"] }));

    restoreDefaultSkills(env);

    expect(JSON.parse(readFileSync(settingsPath(env), "utf8"))).toEqual({ skills: ["!my-own-skill"] });
  });
});

describe("default model in pi's settings.json", () => {
  it("reads nothing when the file is missing or has no default", () => {
    expect(readDefaultModel(env)).toBeNull();
    writeFileSync(settingsPath(env), JSON.stringify({ theme: "dark" }));
    expect(readDefaultModel(env)).toBeNull();
  });

  it("writes the default while preserving every other key", () => {
    writeFileSync(settingsPath(env), JSON.stringify({ theme: "dark", defaultThinkingLevel: "max" }));

    writeDefaultModel({ provider: "hifox", id: "glm-5.3-flash" }, env);

    expect(readDefaultModel(env)).toEqual({ provider: "hifox", id: "glm-5.3-flash" });
    const written = JSON.parse(readFileSync(settingsPath(env), "utf8"));
    expect(written.theme).toBe("dark");
    expect(written.defaultThinkingLevel).toBe("max");
    expect(existsSync(`${settingsPath(env)}.bak`)).toBe(true);
  });

  it("creates the file when there is nothing to preserve", () => {
    writeDefaultModel({ provider: "p", id: "m" }, env);
    expect(JSON.parse(readFileSync(settingsPath(env), "utf8"))).toEqual({
      defaultProvider: "p",
      defaultModel: "m",
    });
  });
});

describe("models.json editing", () => {
  const base = {
    providers: {
      hifox: {
        baseUrl: "http://127.0.0.1:8090/v1",
        api: "openai-completions",
        apiKey: "secret",
        compat: { keep: true },
        models: [{ id: "glm-5.3-flash", name: "glm-5.3-flash", contextWindow: 1310720 }],
      },
    },
  };

  const seed = () => writeFileSync(modelsPath(env), JSON.stringify(base));

  it("creates a new provider and keeps the key when the field is left blank", () => {
    seed();
    upsertProvider("local", { baseUrl: "http://localhost:1234/v1", api: "" }, env);
    expect(readModelsConfig(env).providers?.local).toMatchObject({
      baseUrl: "http://localhost:1234/v1",
      api: "openai-completions",
    });

    upsertProvider("hifox", { baseUrl: "http://127.0.0.1:8090/v1", api: "openai-completions" }, env);
    expect(readModelsConfig(env).providers?.hifox.apiKey).toBe("secret");
    expect(readModelsConfig(env).providers?.hifox.compat).toEqual({ keep: true });
  });

  it("replaces the key when one is given", () => {
    seed();
    upsertProvider(
      "hifox",
      { baseUrl: "http://127.0.0.1:8090/v1", api: "openai-completions", apiKey: "new" },
      env,
    );
    expect(readModelsConfig(env).providers?.hifox.apiKey).toBe("new");
  });

  it("adds and updates models, then removes them", () => {
    seed();
    addModel("hifox", { id: "gpt-x", name: "GPT X", contextWindow: 65536 }, env);
    expect(listProviders(env).find((p) => p.id === "hifox")?.models).toContainEqual({
      id: "gpt-x",
      name: "GPT X",
      reasoning: false,
      contextWindow: 65536,
    });

    addModel("hifox", { id: "gpt-x", name: "GPT X2" }, env);
    const models = listProviders(env).find((p) => p.id === "hifox")?.models ?? [];
    expect(models.filter((model) => model.id === "gpt-x")).toHaveLength(1);
    expect(models.find((model) => model.id === "gpt-x")?.name).toBe("GPT X2");

    removeModel("hifox", "gpt-x", env);
    expect(
      listProviders(env)
        .find((p) => p.id === "hifox")
        ?.models.map((m) => m.id),
    ).toEqual(["glm-5.3-flash"]);
  });

  it("rejects an empty provider or model id", () => {
    seed();
    expect(() => upsertProvider(" ", { baseUrl: "x", api: "y" }, env)).toThrow();
    expect(() => addModel("hifox", { id: "  " }, env)).toThrow();
  });

  it("refuses to add a model to an unknown provider", () => {
    seed();
    expect(() => addModel("nope", { id: "m" }, env)).toThrow(/不存在/);
  });

  it("removes a provider and backs the file up first", () => {
    seed();
    removeProvider("hifox", env);
    expect(listProviders(env)).toEqual([]);
    expect(existsSync(`${modelsPath(env)}.bak`)).toBe(true);
  });

  it("summarises without ever exposing the key", () => {
    seed();
    const [provider] = listProviders(env);
    expect(provider.hasKey).toBe(true);
    expect(JSON.stringify(provider)).not.toContain("secret");
  });

  it("offers the models of a provider with an inline key", () => {
    seed();
    expect(availableModels(env).map((model) => `${model.provider}/${model.id}`)).toEqual([
      "hifox/glm-5.3-flash",
    ]);
  });

  it("accepts a credential stored in auth.json", () => {
    writeFileSync(
      modelsPath(env),
      JSON.stringify({
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            api: "openai-responses",
            models: [{ id: "gpt-x", name: "GPT X" }],
          },
        },
      }),
    );
    expect(availableModels(env)).toEqual([]);

    writeFileSync(join(dir, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "stored" } }));
    expect(availableModels(env).map((model) => model.id)).toEqual(["gpt-x"]);
    expect(listProviders(env)[0]?.hasKey).toBe(true);
  });

  it("resolves an environment placeholder in models.json", () => {
    writeFileSync(
      modelsPath(env),
      JSON.stringify({
        providers: {
          gateway: {
            baseUrl: "https://gateway/v1",
            api: "openai-completions",
            apiKey: "$" + "{GATEWAY_KEY}",
            models: [{ id: "gateway-model" }],
          },
        },
      }),
    );
    expect(availableModels(env)).toEqual([]);
    expect(availableModels({ ...env, GATEWAY_KEY: "secret" }).map((model) => model.id)).toEqual([
      "gateway-model",
    ]);
  });

  it("falls back to a provider's standard environment variable", () => {
    writeFileSync(
      modelsPath(env),
      JSON.stringify({
        providers: {
          custom: {
            baseUrl: "https://custom/v1",
            api: "openai-completions",
            models: [{ id: "custom-model" }],
          },
        },
      }),
    );
    expect(availableModels({ ...env, CUSTOM_API_KEY: "secret" }).map((model) => model.id)).toEqual([
      "custom-model",
    ]);
  });
});
