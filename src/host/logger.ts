/**
 * Append-only log file for the desktop app.
 *
 * A packaged app has no terminal: whatever the processes print is gone. This is
 * the one place the app writes diagnostics to a file, so a user report ("it got
 * stuck") leaves something to read afterwards.
 *
 * One file per day: `application-2026-10-27.log`. The process writes to
 * `application.log`; when the day changes that file is renamed into place, which is
 * what keeps a window left open overnight from piling everything into one file.
 *
 * Backed by `electron-log`'s node entry point — no dependencies, and one API the
 * main process and every worker can share without importing electron.
 */
import { existsSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import log from "electron-log/node";

export type LogLevel = "debug" | "info" | "warn" | "error";

/** How many days of logs stay on disk. */
const KEEP_DAYS = 7;
const ACTIVE = "application.log";
const ARCHIVE = /^application-(\d{4}-\d{2}-\d{2})\.log$/;

let file: string | null = null;
let currentTag = "app";
let scoped: ReturnType<typeof log.scope> = log;

// Nothing is written until `initLogger` says where: electron-log would otherwise
// pick its own default path on the first line, before the app has decided.
log.transports.file.level = false;
log.transports.console.level = false;

/**
 * Start writing to `<dir>/application.log`. Called once per process — the main
 * process and each worker share the file, tagged by process.
 */
export function initLogger(
  dir: string,
  options: { level?: LogLevel; tag?: string; appName?: string; keepDays?: number } = {},
): string {
  // A worker may be the first thing to run on a new day; rolling here means the
  // file it writes to is already today's.
  rollDaily(dir, new Date(), options.keepDays ?? KEEP_DAYS);
  file = join(dir, ACTIVE);
  // The path variables are computed before `resolvePathFn` runs, and they need an
  // app name; a worker's cwd is the user's workspace, which has no package.json.
  log.transports.file.setAppName(options.appName ?? "harness-agent");
  log.transports.file.resolvePathFn = () => file as string;
  // Days bound the size; a second kind of rotation would only confuse the file
  // names.
  log.transports.file.maxSize = 0;
  // We write the whole line ourselves; electron-log just appends it.
  log.transports.file.format = "{text}";
  log.transports.file.level = options.level ?? "info";
  log.transports.console.level = process.env.HARNESS_DEBUG ? "debug" : false;
  // A broken log path would otherwise make electron-log report its own failure
  // through the same broken transport, spamming stderr with a stack trace.
  // `onError` is a documented runtime option but missing from its typings.
  log.errorHandler.setOptions({ onError: () => false, showDialog: false });
  currentTag = options.tag ?? "app";
  scoped = log.scope(currentTag);
  return file;
}

/** `2026-10-27` in the machine's own timezone, not UTC. */
function dayOf(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Move yesterday's `application.log` to `application-<day>.log` and drop files older
 * than `keepDays`. Safe to call at any time: a file that is still today's is
 * left alone.
 */
export function rollDaily(dir: string, now: Date, keepDays = KEEP_DAYS): void {
  const active = join(dir, ACTIVE);
  try {
    if (existsSync(active)) {
      const day = dayOf(statSync(active).mtime);
      if (day !== dayOf(now)) {
        const target = join(dir, `application-${day}.log`);
        if (existsSync(target)) {
          // Two rolls in one day (clock change, restart): keep both.
          renameSync(active, join(dir, `application-${day}-${now.getTime()}.log`));
        } else {
          renameSync(active, target);
        }
      }
    }
  } catch {
    // A log file that cannot be moved is not worth failing the app over.
  }

  try {
    const archives = readdirSync(dir)
      .map((name) => ({ name, day: ARCHIVE.exec(name)?.[1] }))
      .filter((entry): entry is { name: string; day: string } => Boolean(entry.day))
      .sort((a, b) => b.day.localeCompare(a.day));
    for (const entry of archives.slice(keepDays)) {
      unlinkSync(join(dir, entry.name));
    }
  } catch {
    // Same here: pruning is housekeeping, not a requirement.
  }
}

export function logFilePath(): string | null {
  return file;
}

export const logger = {
  debug: (message: string, meta?: unknown) => emit("debug", message, meta),
  info: (message: string, meta?: unknown) => emit("info", message, meta),
  warn: (message: string, meta?: unknown) => emit("warn", message, meta),
  error: (message: string, meta?: unknown) => emit("error", message, meta),
};

/**
 * One line per entry:
 *
 *   2026-10-27 10:29:27.884  info   main    prompt           session=cab8d009 chars=9
 *
 * Values are `key=value` rather than JSON: a person reads the log far more often
 * than a machine does, and `grep session=cab8d009` works either way.
 */
function formatLine(level: LogLevel, message: string): string {
  const time = new Date().toISOString().replace("T", " ").slice(0, 23);
  // Padding is trimmed at the end of the whole line, so a line without meta does
  // not keep the gap the columns were aligned for.
  return `${time}  ${level.padEnd(5)} ${currentTag.padEnd(6)} ${message.padEnd(16)}`;
}

/**
 * Ids are 36 characters and would drown the line. The first eight of the uuid
 * are enough to correlate; the full id is in `sessions.json` and the transcript
 * filename. pi's ids are branded (`harness-agent-<uuid>`), so the uuid is found
 * rather than assumed to be at the start.
 */
const SHORT_KEYS = new Set(["sessionId", "piSessionId"]);

function shortenId(id: string): string {
  const uuid = /([\da-f]{8})-[\da-f]{4}-/i.exec(id);
  return uuid ? uuid[1] : id.slice(-8);
}

/** Render one value: bare when it is simple, quoted when it contains spaces. */
function formatValue(value: unknown): string {
  if (value instanceof Error) return quote(`${value.name}: ${value.message}`);
  if (value === null) return "null";
  if (typeof value === "object") {
    try {
      return quote(JSON.stringify(value));
    } catch {
      return quote(String(value));
    }
  }
  const text = String(value);
  return /^[\w./:@+-]+$/.test(text) ? text : quote(text);
}

/** Quoted, with newlines escaped: one entry stays one line, whatever it contains. */
function quote(text: string): string {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, "\\n")}"`;
}

/** `key=value key=value`, or nothing when there is no meta. */
function formatMeta(meta: unknown): string {
  if (meta === undefined) return "";
  if (meta instanceof Error) {
    const head = `  error=${formatValue(meta)}`;
    const stack = (meta.stack ?? "").split("\n").slice(1).join("\n");
    return stack ? `${head}\n${stack}` : head;
  }
  if (meta === null || typeof meta !== "object") return `  ${formatValue(meta)}`;
  const pairs = Object.entries(meta as Record<string, unknown>).map(([key, value]) => {
    const short = SHORT_KEYS.has(key) && typeof value === "string" ? shortenId(value) : null;
    return `${key}=${short ?? formatValue(value)}`;
  });
  return pairs.length > 0 ? `  ${pairs.join(" ")}` : "";
}

function emit(level: LogLevel, message: string, meta: unknown): void {
  scoped[level](`${formatLine(level, message)}${formatMeta(meta)}`.trimEnd());
}
