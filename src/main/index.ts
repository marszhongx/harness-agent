/**
 * Electron main process.
 *
 * Holds the app shell only: window, tray, notifications, login item, and the
 * IPC surface the renderer is allowed to use. The agent loop lives in a
 * utilityProcess owned by `AgentHost`.
 *
 * Layout: src/main is the shell, src/preload the only bridge, src/renderer the
 * UI, src/host everything that does not need the electron module, and
 * src/shared the IPC contract both sides of the bridge use.
 *
 * Run:
 *   pnpm dev                                  # normal app
 *   pnpm dev -- --smoke                       # headless check, exits 0/1
 */

import { randomUUID } from "node:crypto";
import {
  existsSync,
  type FSWatcher,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  watch,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  Notification,
  nativeImage,
  nativeTheme,
  protocol,
  screen,
  shell,
  Tray,
} from "electron";
import { AgentHost } from "../host/agent-host.ts";
import { AppSettingsStore, type ThemeSetting, type WindowState } from "../host/app-settings.ts";
import { type Draft, Drafts } from "../host/drafts.ts";
import { initLogger, logger, rollDaily } from "../host/logger.ts";
import {
  addModel,
  availableModels,
  listProviders,
  modelsPath,
  removeModel,
  removeProvider,
  upsertProvider,
} from "../host/models-config.ts";
import {
  type DefaultModel,
  readDefaultModel,
  readDefaultThinkingLevel,
  writeDefaultModel,
} from "../host/pi-settings.ts";
import type { DialogRequest, UiAnswer, WorkerToHost } from "../host/protocol.ts";
import { mintSessionId } from "../host/session-id.ts";
import { SessionStore } from "../host/session-store.ts";
import { listSkills, readSkillFile, removeSkill } from "../host/skills.ts";
import { readTranscript } from "../host/transcript-file.ts";
import { attachExistingTranscript } from "../host/transcript-sync.ts";
import { checkWorkspace, ensureDefaultWorkspace } from "../host/workspace.ts";
import type { AgentStatus, ModelProbe, SessionSummary, SettingsSnapshot } from "../shared/contract.ts";
import { IpcAction } from "../shared/ipc-action.ts";

app.setName("harness-agent");

const APP_SCHEME = "app";
const APP_ORIGIN = `${APP_SCHEME}://bundle`;

/**
 * The window loads over `app://` rather than `file://`.
 *
 * A file URL has no real origin: every page shares `null`, so CSP, storage and
 * fetch rules behave differently than they would for a served app. A standard,
 * secure scheme gives the renderer a stable origin without starting an HTTP
 * server for it.
 */
protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

const here = dirname(fileURLToPath(import.meta.url));
// src/main/index.ts -> repository root
const repoRoot = resolve(here, "../..");
const smoke = process.argv.includes("--smoke");
const demo = process.argv.includes("--demo");
/** `--shot=path` writes one window screenshot and exits. No focus stealing. */
const shotArg = process.argv.find((arg) => arg.startsWith("--shot="));
const shotPath = shotArg ? shotArg.slice("--shot=".length) : null;
/** `--shot-delay=ms` widens the window a driven check has to finish in. */
const shotDelayArg = process.argv.find((arg) => arg.startsWith("--shot-delay="));
const shotDelay = shotDelayArg ? Number(shotDelayArg.slice("--shot-delay=".length)) : 8_000;
/** `--shot-size=1440x900` renders at that content size instead of the saved one. */
const shotSizeArg = process.argv.find((arg) => arg.startsWith("--shot-size="));
const shotSize = (() => {
  const match = /^(\d+)x(\d+)$/.exec(shotSizeArg?.slice("--shot-size=".length) ?? "");
  return match ? { width: Number(match[1]), height: Number(match[2]) } : null;
})();
/**
 * `--shot-state=path.js` runs a snippet in the window before the capture.
 *
 * A screenshot should show a state, not a sequence of clicks: the snippet sets
 * store state (or anything else in the page) and the capture shows the result.
 */
const shotStateArg = process.argv.find((arg) => arg.startsWith("--shot-state="));
const shotState = shotStateArg ? shotStateArg.slice("--shot-state=".length) : null;

/**
 * One window, one set of files.
 *
 * Two instances would both write `sessions.json` and silently overwrite each
 * other's list, so a second launch just raises the first one instead. The
 * headless modes (smoke, screenshot) are exempt: they run beside the real app.
 */
if (!smoke && !shotPath) {
  if (!app.requestSingleInstanceLock()) app.quit();
  else
    app.on("second-instance", () => {
      if (!window) return;
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    });
}

const piCliPath = resolve(repoRoot, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
const workerEntry = resolve(repoRoot, "src/host/worker.ts");
/** Our own version; `app.getVersion()` reports Electron's when the entry is a file. */
const appVersion = (() => {
  try {
    return String(JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version ?? "0.0.0");
  } catch {
    return "0.0.0";
  }
})();
// Vite output. `src/renderer/dist` keeps the build inside `src/`, so packaging
// (which ignores the repository's own `dist/`) still ships it.
const rendererDir = resolve(repoRoot, "src/renderer/dist");
/** Point the window at Vite's dev server for HMR instead of the built files. */
const devServerUrl = process.env.HARNESS_UI_DEV_URL?.trim() ?? null;
const rendererUrl = `${APP_ORIGIN}/index.html`;

/**
 * What a session without a model of its own runs on.
 *
 * Read on every use rather than cached at startup: pi's settings file is the
 * single source of truth, and a default changed with the pi CLI (or by editing
 * the file) has to apply to the next spawn and to the menu's star.
 *
 * `null` means nobody has chosen yet. The spawn then omits the flags and pi
 * resolves one itself; whatever it reports is recorded on the session, so every
 * later spawn does pass it explicitly.
 */
function resolveDefaultModel(): DefaultModel | null {
  return readDefaultModel();
}

/**
 * One worker (and therefore one pi process) per conversation.
 *
 * pi processes are independent, so a conversation gets its own instead of
 * sharing one that has to be rebound: switching is then a pure view change, and
 * two conversations can run at the same time. No cap — a worker lives until the
 * app quits.
 */
const hosts = new Map<string, AgentHost>();
/** Temporary hosts used by the model test button; not sessions, not in `hosts`. */
const probeHosts = new Set<AgentHost>();
/** Sessions with a turn in flight, so quit can ask before interrupting them. */
const workingSessions = new Set<string>();

/** Sessions whose model/skill config changed while their turn was running. */
const reloadOnSettle = new Set<string>();

function hostFor(sessionId: string): AgentHost | undefined {
  return hosts.get(sessionId);
}

/**
 * `models.json` belongs to pi and can be edited while the app is open. Watching
 * the directory (not the file) survives the tmp+rename writes this app uses.
 */
function watchModels(): void {
  const directory = dirname(modelsPath());
  try {
    if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
    modelsWatcher = watch(directory, { persistent: false }, (_event, filename) => {
      if (filename && filename.toString() !== "models.json") return;
      send(IpcAction.agent.event, { type: "models_changed" });
    });
    modelsWatcher.on("error", (error) => logger.error("models watcher failed", error));
  } catch (error) {
    logger.error("models watcher failed", error);
  }
}
/** Set once the user has accepted interrupting work, so the second quit goes through. */
let quitConfirmed = false;
let window: BrowserWindow | null = null;
let tray: Tray | null = null;
/** Watches pi's models file so an external edit reaches the renderer. */
let modelsWatcher: FSWatcher | null = null;

/** A dialog waiting for the renderer, keyed by the id the renderer sees. */
interface PendingDialogEntry {
  sessionId: string;
  resolve: (answer: UiAnswer) => void;
  /** UI-side fallback so a card cannot outlive the worker's own timeout. */
  timer: NodeJS.Timeout | null;
}
const pendingDialogs = new Map<string, PendingDialogEntry>();
/** Where the app keeps its own state; smoke runs get their own tree. */
function appBase(): string {
  return smoke ? join(app.getPath("temp"), `harness-agent-smoke-${process.pid}`) : app.getPath("userData");
}

/**
 * One canonical spelling per directory.
 *
 * `/tmp/x` and `/private/tmp/x` are the same directory on macOS; without this a
 * session created under one spelling would look like it belonged elsewhere.
 */
function normalizeWorkspace(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

/** Directory a *new* session starts in: the chosen one, or the app's own. */
function defaultWorkspace(): string {
  const chosen = smoke ? null : appSettings.value.workspacePath;
  const dir = chosen ?? join(appBase(), "workspace");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return normalizeWorkspace(dir);
}

/**
 * The folder a conversation works in, as recorded. No checks here: `status` may
 * report a path that has since been deleted, so the view can say why it broke.
 * A draft has an id before it has an index entry; its folder is still a choice.
 */
function sessionWorkspacePath(sessionId: string): string {
  if (isDraft(sessionId)) return drafts.workspacePath(defaultWorkspace());
  return store.get(sessionId)?.workspacePath ?? ensureDefaultWorkspace(defaultWorkspace);
}

/**
 * The same path, but refused when it is gone.
 *
 * A conversation is bound to the directory it was opened in, so quietly moving
 * to another one would write the user's files somewhere they did not ask for.
 * The turn fails instead, and the composer shows why.
 */
function requireSessionWorkspace(sessionId: string): string {
  const path = sessionWorkspacePath(sessionId);
  const problem = checkWorkspace(path);
  if (problem) throw new Error(problem);
  return path;
}

/** Diagnostics for support: one file, rotated once it passes 2 MB. */
function logsDir(): string {
  return join(appBase(), "logs");
}

/** Where pi keeps transcripts: ours, not the user's ~/.pi, and one flat directory. */
function sessionsDir(): string {
  const dir = join(appBase(), "sessions");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * The session index is ours: ids, titles, ordering, and which transcript each
 * session owns. pi is only where transcripts are written, under the branded
 * spelling of these ids. It sits next to `sessions/` so the index and the
 * transcripts it points at travel together.
 *
 * Smoke runs are throwaway like the rest of their state: opening the real index
 * would rewrite the user's session list.
 */
// Diagnostics before anything can fail: a packaged app has no terminal.
const logFile = initLogger(logsDir(), {
  level: process.env.HARNESS_DEBUG ? "debug" : "info",
  tag: "main",
  appName: app.getName(),
});
// A window left open overnight must move the file at midnight, not at the next
// launch; workers roll when they start, main has to do it while it runs.
setInterval(() => rollDaily(logsDir(), new Date()), 10 * 60 * 1000).unref();
process.on("uncaughtException", (error) => logger.error("uncaughtException", error));
process.on("unhandledRejection", (reason) => logger.error("unhandledRejection", reason));

const appSettings = new AppSettingsStore(join(appBase(), "settings.json"));
/** One index for every workspace; each entry records the directory it lives in. */
const store = new SessionStore(join(appBase(), "sessions.json"));

function send(channel: string, payload: unknown): void {
  if (window && !window.isDestroyed()) window.webContents.send(channel, payload);
}

/**
 * The one path a prompt takes: the store learns about the activity (and takes
 * its title from the first message) regardless of who sent it — the composer or
 * the demo driver.
 */
async function promptAgent(
  sessionId: string,
  message: string,
  images?: Array<{ data: string; mimeType: string }>,
): Promise<string | null> {
  // Refuse the turn before anything is written: a conversation whose folder is
  // gone must not be recorded, and must not silently run somewhere else.
  const workspace = isDraft(sessionId)
    ? drafts.workspacePath(ensureDefaultWorkspace(defaultWorkspace))
    : sessionWorkspacePath(sessionId);
  const problem = checkWorkspace(workspace);
  if (problem) {
    logger.error("workspace unavailable", { sessionId, workspace });
    throw new Error(problem);
  }

  if (isDraft(sessionId)) promoteDraft(message);
  else store.touch(sessionId, message);
  const target = await ensureSession(sessionId);
  if (!target) return null;
  workingSessions.add(sessionId);
  // One line per turn: with the matching `settled`/`error` below, a stuck
  // conversation can be spotted in the log without reading the transcript.
  logger.info("prompt", { sessionId, chars: message.length, images: images?.length ?? 0 });
  try {
    return await target.prompt(message, images);
  } catch (error) {
    logger.error("prompt failed", { sessionId, error: String(error) });
    workingSessions.delete(sessionId);
    throw error;
  }
}

/** Every event is tagged with the conversation it came from. */
function forwardToRenderer(sessionId: string, message: WorkerToHost): void {
  // `ui_request` is delivered through `askUser` instead, so the renderer never
  // sees the same dialog twice.
  if (message.type === "ui_request") return;
  // A turn that ended cannot have a dialog left to answer.
  if (message.type === "settled" || (message.type === "error" && message.fatal)) {
    cancelDialogs(sessionId);
  }
  // Only a settled turn or a turn-ending error means the session is idle again.
  // A command error (a failed thinking-level switch, a duplicate prompt) leaves
  // the running turn alone.
  const endsTurn =
    message.type === "settled" || (message.type === "error" && (message.fatal || message.turnEnded === true));
  if (endsTurn) {
    workingSessions.delete(sessionId);
    if (message.type === "error" && message.fatal) {
      // The host's crash recovery spawns a worker that reads the new config.
      reloadOnSettle.delete(sessionId);
    } else {
      reloadWhenSettled(sessionId);
    }
  }
  if (message.type === "settled" || message.type === "error") {
    logger.info(
      message.type,
      message.type === "error" ? { sessionId, error: message.message } : { sessionId },
    );
  }
  if (message.type === "model") store.setModel(sessionId, message.provider, message.id);
  if (message.type === "thinking") store.setThinkingLevel(sessionId, message.level);
  if (message.type === "settled") {
    store.touch(sessionId);
    // The transcript exists only after the first message; record it now that it does.
    attachExistingTranscript(store, sessionId, hostFor(sessionId)?.sessionFile);
  }
  if (message.type === "notify" && message.level === "error") {
    new Notification({ title: "Agent", body: message.message }).show();
  }
  send(IpcAction.agent.event, { ...message, sessionId });
}

/**
 * Ask the renderer, under an id that is unique across every conversation.
 *
 * Worker-side dialog ids restart at `d1` in each worker, so they cannot be the
 * key here: two conversations asking at once would overwrite each other. The
 * answer goes back through `AgentHost`, which still knows the worker's id.
 */
function askUser(sessionId: string, dialog: DialogRequest): Promise<UiAnswer> {
  if (!window || window.isDestroyed()) return Promise.resolve({ kind: "cancel" });
  notifyWaiting(sessionId);
  const requestId = randomUUID();
  return new Promise<UiAnswer>((resolve) => {
    // The worker enforces its own timeout; this one keeps a stale card from
    // surviving on screen when pi has already moved on.
    const timeout = "timeout" in dialog ? dialog.timeout : undefined;
    const timer =
      typeof timeout === "number" && timeout > 0
        ? setTimeout(() => {
            if (!pendingDialogs.delete(requestId)) return;
            resolve({ kind: "cancel" });
            send(IpcAction.agent.event, { type: "dialog_cancelled", sessionId, requestId });
          }, timeout)
        : null;
    pendingDialogs.set(requestId, { sessionId, resolve, timer });
    send(IpcAction.agent.dialog, { sessionId, requestId, dialog });
  });
}

/**
 * Bring a background approval to the front when the window is not focused.
 *
 * The sidebar marks the conversation too; this is the case where the window is
 * in another app and the user would otherwise never see that a turn is blocked.
 */
function notifyWaiting(sessionId: string): void {
  if (!window || window.isDestroyed() || window.isFocused()) return;
  const title = store.get(sessionId)?.title;
  try {
    const notification = new Notification({
      title: "需要确认",
      body: title ? `「${title}」正在等待你的确认` : "有一个会话正在等待你的确认",
    });
    notification.on("click", () => {
      if (!window || window.isDestroyed()) return;
      window.show();
      window.focus();
    });
    notification.show();
  } catch {
    // Notifications are best-effort: the sidebar badge remains.
  }
}

/**
 * Drop dialogs nobody can answer any more: the turn ended, the worker died, the
 * conversation was deleted, or the window closed. The waiting `AgentHost` writes
 * the cancel back to pi (a no-op when that worker is already gone).
 */
function cancelDialogs(sessionId?: string): void {
  for (const [requestId, entry] of pendingDialogs) {
    if (sessionId && entry.sessionId !== sessionId) continue;
    if (entry.timer) clearTimeout(entry.timer);
    pendingDialogs.delete(requestId);
    entry.resolve({ kind: "cancel" });
    send(IpcAction.agent.event, { type: "dialog_cancelled", sessionId: entry.sessionId, requestId });
  }
}

/**
 * Serve the renderer. Paths are resolved inside `src/renderer` and anything that
 * escapes it is refused, so a malformed URL cannot read the rest of the disk.
 */
function registerAppProtocol(): void {
  const contentTypes: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".json": "application/json",
  };
  protocol.handle(APP_SCHEME, async (request) => {
    const { pathname } = new URL(request.url);
    const relative = decodeURIComponent(pathname).replace(/^\/+/, "") || "index.html";
    const file = resolve(rendererDir, relative);
    if (file !== rendererDir && !file.startsWith(`${rendererDir}/`)) {
      return new Response("forbidden", { status: 403 });
    }
    try {
      const body = await readFile(file);
      const type = contentTypes[extname(file)] ?? "application/octet-stream";
      return new Response(body, { headers: { "content-type": type } });
    } catch {
      // The usual cause is a missing build; say so instead of showing a blank window.
      return new Response(
        existsSync(rendererDir)
          ? "not found"
          : "renderer not built — run `pnpm build:ui` (or `pnpm dev`, which builds first)",
        { status: existsSync(rendererDir) ? 404 : 503, headers: { "content-type": "text/plain" } },
      );
    }
  });
}

/** The saved rectangle, if it still lands on a screen that exists now. */
function savedBounds(): WindowState | null {
  const saved = appSettings.value.window;
  if (!saved) return null;
  const visible = screen.getAllDisplays().some((display) => {
    const area = display.workArea;
    return (
      saved.x < area.x + area.width &&
      saved.x + saved.width > area.x &&
      saved.y < area.y + area.height &&
      saved.y + saved.height > area.y
    );
  });
  return visible ? saved : null;
}

function createWindow(): void {
  const saved = savedBounds();
  window = new BrowserWindow({
    width: saved?.width ?? 980,
    height: saved?.height ?? 720,
    ...(saved ? { x: saved.x, y: saved.y } : {}),
    titleBarStyle: "hiddenInset",
    backgroundColor: "#0f1115",
    webPreferences: {
      preload: resolve(here, "../preload/index.ts"),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
      // Screenshot mode runs behind the real app; without this Chromium stops
      // painting an occluded window and `capturePage` returns a stale frame.
      backgroundThrottling: false,
    },
  });
  if (saved?.maximized) window.maximize();
  // A reload throws away the renderer's dialog queue. Cancel the requests it
  // can no longer answer instead of leaving pi blocked on them. The initial
  // load runs this with nothing pending.
  window.webContents.on("did-start-loading", () => cancelDialogs());
  void window.loadURL(devServerUrl ?? rendererUrl);
  window.show();
  window.focus();
  window.on("close", () => {
    // `getNormalBounds` is the size to restore to, not the maximised rectangle.
    if (!window) return;
    const bounds = window.getNormalBounds();
    appSettings.update({
      window: { ...bounds, maximized: window.isMaximized() },
    });
  });
  window.on("closed", () => {
    // Nobody can answer a pending dialog once the window is gone; cancel them
    // instead of letting every worker wait for pi's timeout.
    cancelDialogs();
    window = null;
  });
}

function createTray(): void {
  const iconPath = resolve(here, "trayTemplate.png");
  if (!existsSync(iconPath)) return;
  const image = nativeImage.createFromPath(iconPath);
  image.setTemplateImage(true);
  tray = new Tray(image);
  tray.setToolTip("harness-agent");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open", click: () => (window ? window.show() : createWindow()) },
      { type: "separator" },
      {
        label: "Quit",
        click: () => {
          // `before-quit` decides whether a running turn needs confirmation.
          app.quit();
        },
      },
    ]),
  );
}

function registerIpc(): void {
  ipcMain.handle(IpcAction.agent.status, (_event, requested?: string): AgentStatus => {
    const sessionId = typeof requested === "string" ? requested : "";
    const live = hostFor(sessionId);
    return {
      sessionId,
      piSessionId: live?.piSessionId ?? null,
      sessionFile: live?.sessionFile ?? store.get(sessionId)?.sessionFile ?? null,
      model: live?.model ?? store.get(sessionId)?.model?.id ?? resolveDefaultModel()?.id ?? null,
      workspacePath:
        !sessionId || isDraft(sessionId)
          ? drafts.workspacePath(defaultWorkspace())
          : sessionWorkspacePath(sessionId),
      working: workingSessions.has(sessionId),
      workerPid: live?.workerPid ?? null,
    };
  });
  /**
   * The transcript, read straight from disk.
   *
   * Showing a conversation must not cost a pi process: the file is documented,
   * append-only and versioned, and reading it is what makes switching instant.
   */
  ipcMain.handle(IpcAction.agent.history, (_event, sessionId?: string) => {
    const id = typeof sessionId === "string" ? sessionId : "";
    const file = store.get(id)?.sessionFile;
    if (!file) return null;
    const items = readTranscript(join(sessionsDir(), file));
    return items.length > 0 ? items : null;
  });
  ipcMain.handle(IpcAction.agent.models, () => availableModels());
  ipcMain.handle(IpcAction.agent.defaultModel, () => resolveDefaultModel());
  ipcMain.handle(IpcAction.agent.setDefaultModel, (_event, nextProvider: string, nextId: string) => {
    if (typeof nextProvider !== "string" || typeof nextId !== "string") return;
    writeDefaultModel({ provider: nextProvider, id: nextId });
  });

  ipcMain.handle(
    IpcAction.agent.prompt,
    (_event, sessionId: string, message: string, images?: Array<{ data: string; mimeType: string }>) =>
      promptAgent(sessionId, message, images),
  );
  ipcMain.handle(IpcAction.agent.abort, (_event, sessionId: string) =>
    hostFor(typeof sessionId === "string" ? sessionId : "")?.abort(),
  );
  // `working` comes from the live process set, so a reloaded window can trust
  // the list instead of keeping its own guess.
  ipcMain.handle(IpcAction.agent.listSessions, (): SessionSummary[] =>
    store.list().map((entry) => ({ ...entry, working: workingSessions.has(entry.id) })),
  );
  ipcMain.handle(IpcAction.agent.defaultThinkingLevel, () => readDefaultThinkingLevel());
  /**
   * Delete a conversation: its process, its index entry and its transcript.
   *
   * The transcript is pi's file, but it is this conversation and the user asked
   * for it to go. Everything else about the app stays.
   */
  ipcMain.handle(IpcAction.agent.deleteSession, async (_event, sessionId: string) => {
    const id = typeof sessionId === "string" ? sessionId : "";
    if (!id) return;
    const entry = store.remove(id);
    if (!entry) return;

    cancelDialogs(id);
    const live = hosts.get(id);
    if (live) {
      hosts.delete(id);
      await live.dispose().catch(() => undefined);
    }
    workingSessions.delete(id);
    reloadOnSettle.delete(id);
    drafts.forget(id);
    if (entry.sessionFile) {
      try {
        rmSync(join(sessionsDir(), entry.sessionFile), { force: true });
      } catch (error) {
        logger.error("could not delete transcript", { sessionId: id, error: String(error) });
      }
    }
    logger.info("session deleted", { sessionId: id });
  });
  /**
   * Pick the folder for the conversation about to start. Only the draft can be
   * changed: an existing conversation keeps the directory pi opened it in.
   */
  ipcMain.handle(IpcAction.agent.chooseDraftWorkspace, async () => {
    logger.info("choose draft workspace");
    const picked = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"],
      title: "选择这次对话使用的工作目录",
    });
    if (!picked.canceled && picked.filePaths.length > 0) drafts.chooseWorkspace(picked.filePaths[0]);
  });
  ipcMain.handle(IpcAction.agent.newSession, () => {
    // A fresh draft: id minted, nothing written to the index, nothing in the
    // list, and no worker. Other conversations keep their processes.
    return startDraft().id;
  });
  // ── models ────────────────────────────────────────────────────────────────
  // Writes return nothing: the renderer re-reads `models:list` / `agent:models`
  // after a successful mutation instead of decoding a response shape.
  ipcMain.handle(IpcAction.models.list, () => listProviders());
  ipcMain.handle(
    IpcAction.models.upsertProvider,
    async (_event, id: string, input: { baseUrl: string; api: string; apiKey?: string }) => {
      upsertProvider(id, input);
      await reloadWorker();
    },
  );
  ipcMain.handle(IpcAction.models.removeProvider, async (_event, id: string) => {
    removeProvider(id);
    await reloadWorker();
  });
  ipcMain.handle(
    IpcAction.models.addModel,
    async (_event, providerId: string, model: { id: string; name?: string; contextWindow?: number }) => {
      addModel(providerId, model);
      await reloadWorker();
    },
  );
  ipcMain.handle(IpcAction.models.removeModel, async (_event, providerId: string, modelId: string) => {
    removeModel(providerId, modelId);
    await reloadWorker();
  });
  ipcMain.handle(IpcAction.models.test, async (_event, provider: string, model: string) => {
    if (typeof provider !== "string" || typeof model !== "string") {
      return { ok: false, error: "provider/model 不能为空" };
    }
    const result = await probeModel(provider, model);
    logger.info("model probe", { provider, model, ok: result.ok, error: result.error });
    return result;
  });

  // ── skills ────────────────────────────────────────────────────────────────
  ipcMain.handle(IpcAction.skills.list, () => listSkills(defaultWorkspace()));
  ipcMain.handle(IpcAction.skills.remove, async (_event, dir: string) => {
    removeSkill(dir, defaultWorkspace());
    await reloadWorker();
  });
  ipcMain.handle(IpcAction.skills.reveal, (_event, dir: string) => shell.showItemInFolder(dir));
  ipcMain.handle(IpcAction.skills.read, (_event, dir: string) => readSkillFile(dir, defaultWorkspace()));

  // ── settings ──────────────────────────────────────────────────────────────
  const settingsSnapshot = (): SettingsSnapshot => ({
    theme: appSettings.value.theme,
    launchAtLogin: appSettings.value.launchAtLogin,
    workspacePath: defaultWorkspace(),
    workspaceIsCustom: appSettings.value.workspacePath !== null,
    dataDir: appBase(),
    sessionsDir: sessionsDir(),
    logsDir: logsDir(),
    appName: app.getName(),
    appVersion,
    electronVersion: process.versions.electron ?? "",
    nodeVersion: process.versions.node,
  });
  ipcMain.handle(IpcAction.settings.get, () => settingsSnapshot());
  ipcMain.handle(IpcAction.settings.setTheme, (_event, theme: ThemeSetting) => {
    const next = theme === "light" || theme === "dark" ? theme : "system";
    appSettings.update({ theme: next });
    applyTheme(next);
  });
  ipcMain.handle(IpcAction.settings.setLaunchAtLogin, (_event, enabled: boolean) => {
    appSettings.update({ launchAtLogin: enabled === true });
    applyLaunchAtLogin(enabled === true);
  });
  ipcMain.handle(IpcAction.workspace.choose, async () => {
    const picked = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"],
      title: "选择新会话使用的工作目录",
    });
    if (picked.canceled || picked.filePaths.length === 0) return;
    setDefaultWorkspace(picked.filePaths[0]);
  });
  ipcMain.handle(IpcAction.workspace.reset, () => {
    setDefaultWorkspace(null);
  });
  ipcMain.handle(IpcAction.path.reveal, (_event, path: string) => {
    if (typeof path === "string" && path) void shell.openPath(path);
  });

  ipcMain.handle(IpcAction.agent.setThinkingLevel, (_event, sessionId: string, level: string) => {
    if (typeof level !== "string") return;
    // Recorded even without a worker; it is applied when the session next runs.
    if (!sessionId || drafts.holds(sessionId)) {
      drafts.chooseThinkingLevel(sessionId, level);
    } else {
      store.setThinkingLevel(sessionId, level);
      hostFor(sessionId)?.setThinkingLevel(level);
    }
  });

  ipcMain.handle(IpcAction.agent.setModel, (_event, sessionId: string, provider: string, model: string) => {
    if (typeof provider !== "string" || typeof model !== "string") return;
    if (!sessionId || drafts.holds(sessionId)) {
      drafts.chooseModel(sessionId, { provider, id: model });
    } else {
      store.setModel(sessionId, provider, model);
      hostFor(sessionId)?.setModel(provider, model);
    }
  });

  // The renderer answers a dialog. The pending promise in `askUser` resolves
  // and `AgentHost` writes the `extension_ui_response` back to pi.
  ipcMain.handle(IpcAction.agent.answer, (_event, payload: { requestId: string; answer: UiAnswer }) => {
    const entry = pendingDialogs.get(payload.requestId);
    if (!entry) return false;
    if (entry.timer) clearTimeout(entry.timer);
    pendingDialogs.delete(payload.requestId);
    entry.resolve(payload.answer);
    return true;
  });
}

/**
 * A conversation that exists but is not in the index yet.
 *
 * Clicking "new conversation" must not add a row to the list — a conversation
 * only becomes real when it has a message. So the app mints the id pi will use
 * and keeps it here; the first prompt promotes it into the index.
 */
const drafts = new Drafts();

/** Mint the id pi will use for the conversation that does not exist yet. */
function startDraft(): Draft {
  return drafts.begin(mintSessionId(), resolveDefaultModel(), defaultWorkspace());
}

function isDraft(sessionId: string): boolean {
  return drafts.holds(sessionId) && !store.get(sessionId);
}

/** Turn the draft into a real conversation, once it has something to say. */
function promoteDraft(firstMessage: string): void {
  const promotion = drafts.promote(resolveDefaultModel());
  if (!promotion || store.get(promotion.id)) return;
  store.createWithId(promotion.id, promotion.workspacePath);
  store.touch(promotion.id, firstMessage);
  if (promotion.model) store.setModel(promotion.id, promotion.model.provider, promotion.model.id);
  if (promotion.thinkingLevel) store.setThinkingLevel(promotion.id, promotion.thinkingLevel);
}

/** Models and skills are read by pi at startup, so a change is only live after a respawn. */
async function reloadWorker(): Promise<void> {
  // A running turn should not be killed for a settings edit; remember the
  // session and replace its worker once it settles.
  await Promise.all(
    [...hosts.entries()].map(async ([sessionId, live]) => {
      if (workingSessions.has(sessionId)) {
        reloadOnSettle.add(sessionId);
        return;
      }
      await live.restart().catch(() => undefined);
    }),
  );
}

/** Apply a model/skill change that arrived during a turn. */
function reloadWhenSettled(sessionId: string): void {
  if (!reloadOnSettle.delete(sessionId)) return;
  void hostFor(sessionId)
    ?.restart()
    .catch(() => undefined);
}

/** Appearance follows `prefers-color-scheme`, which Electron derives from this. */
function applyTheme(theme: ThemeSetting): void {
  nativeTheme.themeSource = theme;
}

function applyLaunchAtLogin(enabled: boolean): void {
  try {
    app.setLoginItemSettings({ openAtLogin: enabled });
  } catch {
    // Unsupported on some Linux desktops; the setting still persists.
  }
}

/**
 * Change where *new* sessions run. Existing sessions keep the directory they
 * were created in — that is their identity, not a setting.
 */
function setDefaultWorkspace(next: string | null): void {
  appSettings.update({ workspacePath: next ? normalizeWorkspace(next) : null });
}

/** The model this session spawns with: its own, else the current default. */
function chosenModel(sessionId: string): DefaultModel | null {
  return drafts.modelFor(sessionId) ?? store.get(sessionId)?.model ?? resolveDefaultModel();
}

/** Record a deliberate choice, so reopening the session keeps it. */
function recordChoice(sessionId: string, model: DefaultModel | null): void {
  if (model) store.setModel(sessionId, model.provider, model.id);
}

/**
 * Make sure this conversation has a worker.
 *
 * One pi process per conversation, created the first time the conversation is
 * opened or messaged and kept until the app quits. Switching views never touches
 * it, and two conversations can run at the same time.
 */
async function ensureSession(sessionId: string): Promise<AgentHost | null> {
  const existing = hostFor(sessionId);
  if (existing) return existing;
  return startHost(sessionId);
}

async function startHost(sessionId: string): Promise<AgentHost> {
  const spawnModel = chosenModel(sessionId);
  logger.info("spawning worker", {
    sessionId,
    provider: spawnModel?.provider,
    model: spawnModel?.id,
  });
  recordChoice(sessionId, spawnModel);
  const spawnThinking = store.get(sessionId)?.thinkingLevel;
  const started = await AgentHost.start({
    workerEntry,
    piCliPath,
    cwd: requireSessionWorkspace(sessionId),
    sessionDir: sessionsDir(),
    sessionId,
    sessionIdPrefix: app.getName(),
    // No `sessionName`: pi writes the transcript as soon as it is given one, and
    // a draft that never gets a message should leave nothing behind.

    // Explicit whenever we know it: the session's own model, else the default.
    provider: spawnModel?.provider,
    model: spawnModel?.id,
    thinkingLevel: spawnThinking,
    logDir: logsDir(),
    onEvent: (message) => forwardToRenderer(sessionId, message),
    onReady: ({ sessionId, sessionFile }) => {
      logger.info("session ready", { sessionId, sessionFile });
      // Only the transcript is pi's to report. The model is recorded when we pass
      // one deliberately, so a session with no choice stays visibly unchosen.
      // The path pi reports is planned, not necessarily written yet: keep it only
      // once the transcript exists, so the index never points at nothing.
      attachExistingTranscript(store, sessionId, sessionFile);
    },
    askUser: (_requestId, dialog) => askUser(sessionId, dialog),
    onTurnEnd: ({ reason }) => {
      // No `settled` is coming: the turn died with the worker. Clear the same
      // state a normal settle would, so the composer is usable again.
      logger.info("turn ended", { sessionId, reason });
      workingSessions.delete(sessionId);
      // The host is already replacing the worker, so it will read the new config.
      reloadOnSettle.delete(sessionId);
      cancelDialogs(sessionId);
      // A failed first turn has no normal `settled` path above. If pi wrote a
      // partial transcript before dying, keep it in the index now.
      attachExistingTranscript(store, sessionId, hostFor(sessionId)?.sessionFile);
      send(IpcAction.agent.event, { type: "settled", sessionId });
    },
    onRestart: (info) => {
      logger.error("worker restarted", { sessionId, ...info });
      // A crashed worker cannot answer the dialog it asked; `onTurnEnd` has
      // already settled the turn when there was one.
      cancelDialogs(sessionId);
      // Without this the app would think a turn is still running and ask before
      // every quit, even when the crash happened between turns.
      workingSessions.delete(sessionId);
      // The recovery spawn reads the new config; no second restart is needed.
      reloadOnSettle.delete(sessionId);
      send(IpcAction.agent.event, {
        type: "notify",
        message: `worker 已重启（第 ${info.attempt} 次）`,
        sessionId,
      });
    },
  });
  hosts.set(sessionId, started);
  logger.debug("worker started", { sessionId, pid: started.workerPid });
  return started;
}

/**
 * One-off connectivity check for a model, behind the Models page's test button.
 *
 * It uses a temporary worker/pi so no session is opened, no index entry or
 * transcript is written, and nothing survives the request. The result is
 * returned to the page only; it is deliberately not stored in the model store.
 */
const PROBE_PROMPT = "Reply with exactly: MODEL_OK";
const PROBE_TIMEOUT_MS = 45_000;

async function probeModel(provider: string, model: string): Promise<ModelProbe> {
  if (!provider || !model) return { ok: false, error: "provider/model 不能为空" };
  const root = mkdtempSync(join(app.getPath("temp"), "harness-model-probe-"));
  try {
    const cwd = join(root, "workspace");
    const sessionDir = join(root, "sessions");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });

    let reply = "";
    let settled = false;
    let resolveProbe: (result: ModelProbe) => void = () => undefined;
    const result = new Promise<ModelProbe>((resolve) => {
      resolveProbe = resolve;
    });
    const finish = (next: ModelProbe) => {
      if (settled) return;
      settled = true;
      resolveProbe(next);
    };
    const timer = setTimeout(() => finish({ ok: false, error: "测试超时" }), PROBE_TIMEOUT_MS);

    let host: AgentHost | null = null;
    try {
      host = await AgentHost.start({
        workerEntry,
        piCliPath,
        cwd,
        sessionDir,
        sessionIdPrefix: app.getName(),
        provider,
        model,
        // A probe should fail fast, not retry a broken connection.
        maxRestarts: 0,
        readyTimeoutMs: 30_000,
        askUser: () => ({ kind: "cancel" }),
        onEvent: (message) => {
          if (message.type === "text_delta") reply += message.delta;
          else if (message.type === "settled") {
            finish({ ok: reply.trim().length > 0, reply: reply.trim().slice(0, 200) });
          } else if (message.type === "error" && (message.fatal || message.turnEnded === true)) {
            finish({ ok: false, error: message.message });
          }
        },
      });
      probeHosts.add(host);
      await host.prompt(PROBE_PROMPT);
      return await result;
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      clearTimeout(timer);
      if (host) {
        probeHosts.delete(host);
        await host.dispose().catch(() => undefined);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ── headless smoke path ─────────────────────────────────────────────────────

async function runSmoke(): Promise<void> {
  const events: WorkerToHost[] = [];
  let settle: (() => void) | null = null;
  const settled = new Promise<void>((r) => {
    settle = r;
  });

  const started = await AgentHost.start({
    workerEntry,
    piCliPath,
    cwd: defaultWorkspace(),
    sessionDir: sessionsDir(),
    onEvent: (message) => {
      events.push(message);
      if (process.env.HARNESS_DEBUG) console.log(`[event] ${message.type}`);
      if (message.type === "text_delta") process.stdout.write(message.delta);
      if (message.type === "settled") settle?.();
    },
    askUser: () => ({ kind: "cancel" as const }),
  });

  if (!started.sessionId) throw new Error("worker started without a session id");
  process.stdout.write("--- stream ---\n");
  await started.prompt("Reply with exactly: ELECTRON_OK");
  await settled;

  const text = events
    .filter((e): e is Extract<WorkerToHost, { type: "text_delta" }> => e.type === "text_delta")
    .map((e) => e.delta)
    .join("");
  console.log(`\n--- result ---\nsession ${started.sessionId}\ntext    ${JSON.stringify(text.trim())}`);
  await started.dispose();
  if (!text.toUpperCase().includes("ELECTRON_OK")) throw new Error("no ELECTRON_OK in reply");
}

// ── lifecycle ───────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  try {
    if (smoke) {
      await runSmoke();
      console.log("PASS: electron main + utilityProcess worker + pi");
      app.exit(0);
      return;
    }

    logger.info("app started", {
      version: appVersion,
      electron: process.versions.electron,
      node: process.versions.node,
      userData: appBase(),
      workspace: defaultWorkspace(),
      logFile,
    });
    // Without this the Dock shows Electron's own icon during development.
    if (process.platform === "darwin" && app.dock) {
      const iconPath = resolve(repoRoot, "assets/icon.png");
      if (existsSync(iconPath)) {
        app.dock.setIcon(iconPath);
        logger.info("dock icon set", { iconPath });
      }
    }
    applyTheme(appSettings.value.theme);
    applyLaunchAtLogin(appSettings.value.launchAtLogin);
    registerAppProtocol();
    registerIpc();
    createWindow();
    createTray();
    watchModels();
    // Nothing starts a worker at launch: the list, transcript, and catalogue
    // come from disk; pi starts on the first message.
    if (process.platform === "darwin") app.dock?.show();
    // Bring the window forward: launching from a terminal leaves the terminal
    // focused on macOS. Screenshot runs stay in the background on purpose — they
    // are verification, not a request for the user's attention.
    if (!shotPath) {
      app.focus({ steal: true });
      window?.moveTop();
    }
    if (shotPath && window) {
      const target = window;
      if (shotSize) target.setContentSize(shotSize.width, shotSize.height);
      setTimeout(async () => {
        if (shotState) {
          try {
            const result = await target.webContents.executeJavaScript(readFileSync(shotState, "utf8"));
            logger.info("shot-state applied", { url: target.webContents.getURL(), result });
            // Let React paint the state the snippet installed.
            await new Promise((resolve) => setTimeout(resolve, 350));
          } catch (error) {
            logger.error("shot-state failed", error);
          }
        }
        const image = await target.webContents.capturePage();
        if (image) writeFileSync(shotPath, image.toPNG());
        console.log(`shot -> ${shotPath}`);
        app.exit(0);
      }, shotDelay);
    }
    if (demo) {
      // Drive one turn so the window can be inspected with a real transcript.
      setTimeout(() => {
        const id = startDraft().id;
        void promptAgent(id, "用一句话说明你能帮我做什么，然后停。");
      }, 1200);
    }
  } catch (error) {
    logger.error("startup failed", error);
    console.error("startup failed:", error);
    app.exit(1);
  }
});

app.on("activate", () => {
  if (!window) createWindow();
});

app.on("window-all-closed", () => {
  // Tray keeps the app alive; quitting is explicit.
  if (process.platform !== "darwin" && !tray) app.quit();
});

/**
 * Quitting mid-turn silently threw away the run. Ask first, the way a native app
 * would: the dialog names what is interrupted, and Cancel is the default.
 */
app.on("before-quit", (event) => {
  if (quitConfirmed || workingSessions.size === 0) {
    return;
  }
  event.preventDefault();
  const choice = dialog.showMessageBoxSync({
    type: "warning",
    buttons: ["取消", "退出并中断"],
    defaultId: 0,
    cancelId: 0,
    message: "还有任务在运行",
    detail: "退出会中断当前回合，已生成的内容不会补全。",
  });
  if (choice !== 1) return;
  quitConfirmed = true;
  app.quit();
});

app.on("will-quit", () => {
  modelsWatcher?.close();
  modelsWatcher = null;
  // Not awaited on purpose: pi exits by itself when its stdin closes, so even if
  // the app disappears first nothing is left running. This is the polite path.
  for (const live of hosts.values()) void live.dispose();
  hosts.clear();
  for (const probe of probeHosts) void probe.dispose();
  probeHosts.clear();
});
