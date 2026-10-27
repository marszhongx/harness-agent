/**
 * App-level settings: the few choices that are about this window, not about pi.
 *
 * Model default lives in pi's `settings.json` (pi owns it), sessions live per
 * workspace in `sessions.json`. This file only holds what is left: appearance,
 * whether the app starts with the login session, and which workspace new
 * conversations run in.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type ThemeSetting = "system" | "light" | "dark";

export interface WindowState {
  x: number;
  y: number;
  width: number;
  height: number;
  maximized: boolean;
}

export interface AppSettings {
  version: 1;
  theme: ThemeSetting;
  launchAtLogin: boolean;
  /** Absolute path; `null` means the app's own workspace directory. */
  workspacePath: string | null;
  /** Where the window was last time; `null` until it has been closed once. */
  window: WindowState | null;
}

const DEFAULTS: AppSettings = {
  version: 1,
  theme: "system",
  launchAtLogin: false,
  workspacePath: null,
  window: null,
};

export class AppSettingsStore {
  #path: string;
  #value: AppSettings;

  constructor(path: string) {
    this.#path = path;
    this.#value = read(path);
  }

  get value(): AppSettings {
    return { ...this.#value };
  }

  update(patch: Partial<Omit<AppSettings, "version">>): AppSettings {
    this.#value = { ...this.#value, ...patch };
    this.#write();
    return this.value;
  }

  #write(): void {
    try {
      if (!existsSync(dirname(this.#path))) mkdirSync(dirname(this.#path), { recursive: true });
      const temporary = `${this.#path}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(this.#value, null, 2)}\n`);
      renameSync(temporary, this.#path);
    } catch {
      // Losing app settings costs preferences, never conversations.
    }
  }
}

/** A saved rectangle is only trusted when all four numbers survived. */
function readWindow(value: unknown): WindowState | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<WindowState>;
  const numbers = [candidate.x, candidate.y, candidate.width, candidate.height];
  if (!numbers.every((item) => typeof item === "number" && Number.isFinite(item))) return null;
  return {
    x: candidate.x as number,
    y: candidate.y as number,
    width: candidate.width as number,
    height: candidate.height as number,
    maximized: candidate.maximized === true,
  };
}

function read(path: string): AppSettings {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<AppSettings> | null;
    if (raw?.version === 1) {
      const theme = raw.theme === "light" || raw.theme === "dark" ? raw.theme : "system";
      return {
        version: 1,
        theme,
        launchAtLogin: raw.launchAtLogin === true,
        workspacePath: typeof raw.workspacePath === "string" && raw.workspacePath ? raw.workspacePath : null,
        window: readWindow(raw.window),
      };
    }
  } catch {
    // Missing or unreadable: defaults are fine.
  }
  return { ...DEFAULTS };
}
