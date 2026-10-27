/**
 * The default model, stored where pi already stores it.
 *
 * `settings.json` in pi's agent directory is the file pi itself writes when a
 * user picks a default (`SettingsManager.setDefaultModelAndProvider`). Keeping
 * one copy means the app and the CLI cannot disagree about what "default" means
 * — and it is what a fresh session falls back to when it has no model of its
 * own.
 *
 * We still pass `--provider/--model` on every spawn instead of letting pi fall
 * back to this file: the flag is what makes the choice explicit and reviewable,
 * and it keeps a session's own model from being silently ignored.
 *
 * Only the two keys we own are touched; every other setting in the file is
 * preserved, and the previous content is kept beside it as `settings.json.bak`.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface DefaultModel {
  provider: string;
  id: string;
}

/** Same resolution as pi: `PI_CODING_AGENT_DIR`, else `~/.pi/agent`. */
export function agentDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.PI_CODING_AGENT_DIR?.trim();
  return override ? expandHome(override) : join(homedir(), ".pi", "agent");
}

export function settingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(agentDir(env), "settings.json");
}

export function readDefaultModel(env: NodeJS.ProcessEnv = process.env): DefaultModel | null {
  try {
    const raw = JSON.parse(readFileSync(settingsPath(env), "utf8")) as {
      defaultProvider?: unknown;
      defaultModel?: unknown;
    };
    if (typeof raw.defaultProvider === "string" && typeof raw.defaultModel === "string") {
      return { provider: raw.defaultProvider, id: raw.defaultModel };
    }
  } catch {
    // Missing or unreadable: the caller falls back to its own default.
  }
  return null;
}

/** Write `defaultProvider`/`defaultModel`, leaving the rest of the file alone. */
export function writeDefaultModel(model: DefaultModel, env: NodeJS.ProcessEnv = process.env): void {
  const path = settingsPath(env);
  let settings: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (parsed && typeof parsed === "object") settings = parsed as Record<string, unknown>;
      copyFileSync(path, `${path}.bak`);
    } catch {
      // Unparsable: do not guess at its contents, but keep a copy of the bytes.
      try {
        copyFileSync(path, `${path}.bak`);
      } catch {
        // nothing to preserve
      }
    }
  }
  settings.defaultProvider = model.provider;
  settings.defaultModel = model.id;

  const directory = dirname(path);
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
  // tmp + rename, so an interrupted write cannot leave pi with half a settings file.
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`);
  renameSync(temporary, path);
}

function expandHome(path: string): string {
  return path.startsWith("~") ? join(homedir(), path.slice(1).replace(/^[/\\]/, "")) : path;
}
