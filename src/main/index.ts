/**
 * Electron main process.
 *
 * Holds the app shell only: window, tray, notifications, login item, and the
 * IPC surface the renderer is allowed to use. The agent loop lives in a
 * utilityProcess owned by `AgentHost`.
 *
 * Layout: src/main is the shell, src/preload the only bridge, src/renderer the
 * UI, src/host everything that does not need the electron module.
 *
 * Run:
 *   pnpm dev                                  # normal app
 *   pnpm dev -- --smoke                       # headless check, exits 0/1
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
  removeModel,
  removeProvider,
  upsertProvider,
} from "../host/models-config.ts";
import { type DefaultModel, readDefaultModel, writeDefaultModel } from "../host/pi-settings.ts";
import type { DialogRequest, UiAnswer, WorkerToHost } from "../host/protocol.ts";
import { mintSessionId } from "../host/session-id.ts";
import { SessionStore } from "../host/session-store.ts";
import { listSkills, readSkillFile, removeSkill } from "../host/skills.ts";
import { readTranscript } from "../host/transcript-file.ts";
import { checkWorkspace, ensureDefaultWorkspace } from "../host/workspace.ts";

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
/** Sessions with a turn in flight, so quit can ask before interrupting them. */
const workingSessions = new Set<string>();

function hostFor(sessionId: string): AgentHost | undefined {
  return hosts.get(sessionId);
}
/** Set once the user has accepted interrupting work, so the second quit goes through. */
let quitConfirmed = false;
let window: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;

/** Dialogs the renderer has not answered yet, keyed by the worker request id. */
const pendingDialogs = new Map<string, (answer: UiAnswer) => void>();
/**
 * Last transcript the worker pushed. The renderer reads it once on load instead
 * of racing the `history` event, which can fire before its listeners exist.
 */

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
 * A session's working directory is fixed when it is created.
 *
 * pi records the cwd in the session header and refuses to reopen the session
 * from anywhere else, so this is not a preference — it is part of the session's
 * identity, and nothing in the app changes it afterwards.
 */
/**
 * The folder a conversation works in, as recorded. No checks here: `status` may
 * report a path that has since been deleted, so the view can say why it broke.
 */
function sessionWorkspacePath(sessionId: string): string {
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
  if (message.type === "settled" || message.type === "error") {
    workingSessions.delete(sessionId);
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
    const file = hostFor(sessionId)?.sessionFile;
    if (file && existsSync(file)) store.attachFile(sessionId, file);
  }
  if (message.type === "notify" && message.level === "error") {
    new Notification({ title: "Agent", body: message.message }).show();
  }
  send("agent:event", { ...message, sessionId });
}

function askUser(requestId: string, dialog: DialogRequest): Promise<UiAnswer> {
  if (!window || window.isDestroyed()) return Promise.resolve({ kind: "cancel" });
  return new Promise<UiAnswer>((pending) => {
    pendingDialogs.set(requestId, pending);
    send("agent:dialog", { requestId, dialog });
  });
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
    },
  });
  if (saved?.maximized) window.maximize();
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
  ipcMain.handle("agent:status", (_event, requested?: string) => {
    const sessionId = typeof requested === "string" ? requested : "";
    const live = hostFor(sessionId);
    return {
      sessionId,
      piSessionId: live?.piSessionId ?? null,
      sessionFile: live?.sessionFile ?? store.get(sessionId)?.sessionFile ?? null,
      model: live?.model ?? store.get(sessionId)?.model?.id ?? resolveDefaultModel()?.id ?? null,
      workspacePath: sessionId ? sessionWorkspacePath(sessionId) : drafts.workspacePath(defaultWorkspace()),
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
  ipcMain.handle("agent:history", (_event, sessionId?: string) => {
    const id = typeof sessionId === "string" ? sessionId : "";
    const file = store.get(id)?.sessionFile;
    if (!file) return null;
    const items = readTranscript(join(sessionsDir(), file));
    return items.length > 0 ? items : null;
  });
  ipcMain.handle("agent:models", () => availableModels());
  ipcMain.handle("agent:defaultModel", () => resolveDefaultModel());
  ipcMain.handle("agent:setDefaultModel", (_event, nextProvider: string, nextId: string) => {
    if (typeof nextProvider !== "string" || typeof nextId !== "string") return resolveDefaultModel();
    writeDefaultModel({ provider: nextProvider, id: nextId });
    return resolveDefaultModel();
  });

  ipcMain.handle(
    "agent:prompt",
    (_event, sessionId: string, message: string, images?: Array<{ data: string; mimeType: string }>) =>
      promptAgent(sessionId, message, images),
  );
  ipcMain.handle("agent:abort", (_event, sessionId: string) =>
    hostFor(typeof sessionId === "string" ? sessionId : "")?.abort(),
  );
  // `working` comes from the live process set, so a reloaded window can trust
  // the list instead of keeping its own guess.
  ipcMain.handle("agent:listSessions", () =>
    store.list().map((entry) => ({ ...entry, working: workingSessions.has(entry.id) })),
  );
  /**
   * Delete a conversation: its process, its index entry and its transcript.
   *
   * The transcript is pi's file, but it is this conversation and the user asked
   * for it to go. Everything else about the app stays.
   */
  ipcMain.handle("agent:deleteSession", async (_event, sessionId: string) => {
    const id = typeof sessionId === "string" ? sessionId : "";
    if (!id) return store.list();
    const entry = store.remove(id);
    if (!entry) return store.list();

    const live = hosts.get(id);
    if (live) {
      hosts.delete(id);
      await live.dispose().catch(() => undefined);
    }
    workingSessions.delete(id);
    drafts.forget(id);
    if (entry.sessionFile) {
      try {
        rmSync(join(sessionsDir(), entry.sessionFile), { force: true });
      } catch (error) {
        logger.error("could not delete transcript", { sessionId: id, error: String(error) });
      }
    }
    logger.info("session deleted", { sessionId: id });
    return store.list();
  });
  // Switching reopens the transcript pi already has under that id; the new
  // worker's `history` event redraws it. The id arrives in interior form and
  // `AgentHost` brands it for pi.
  /**
   * Pick the folder for the conversation about to start. Only the draft can be
   * changed: an existing conversation keeps the directory pi opened it in.
   */
  ipcMain.handle("agent:chooseDraftWorkspace", async () => {
    logger.info("choose draft workspace");
    const picked = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"],
      title: "选择这次对话使用的工作目录",
    });
    if (!picked.canceled && picked.filePaths.length > 0) drafts.chooseWorkspace(picked.filePaths[0]);
    return { workspacePath: drafts.workspacePath(defaultWorkspace()) };
  });
  ipcMain.handle("agent:newSession", () => {
    // A fresh draft: id minted, nothing written to the index, nothing in the
    // list, and no worker. Other conversations keep their processes.
    return startDraft().id;
  });
  // ── models ────────────────────────────────────────────────────────────────
  ipcMain.handle("models:list", () => listProviders());
  ipcMain.handle(
    "models:upsertProvider",
    async (_event, id: string, input: { baseUrl: string; api: string; apiKey?: string }) => {
      const list = upsertProvider(id, input);
      await reloadWorker();
      return list;
    },
  );
  ipcMain.handle("models:removeProvider", async (_event, id: string) => {
    const list = removeProvider(id);
    await reloadWorker();
    send("agent:event", { type: "models", models: availableModels() });
    return list;
  });
  ipcMain.handle(
    "models:addModel",
    async (_event, providerId: string, model: { id: string; name?: string; contextWindow?: number }) => {
      const list = addModel(providerId, model);
      await reloadWorker();
      return list;
    },
  );
  ipcMain.handle("models:removeModel", async (_event, providerId: string, modelId: string) => {
    const list = removeModel(providerId, modelId);
    await reloadWorker();
    send("agent:event", { type: "models", models: availableModels() });
    return list;
  });

  // ── skills ────────────────────────────────────────────────────────────────
  ipcMain.handle("skills:list", () => listSkills(defaultWorkspace()));
  ipcMain.handle("skills:remove", async (_event, dir: string) => {
    const list = removeSkill(dir, defaultWorkspace());
    await reloadWorker();
    return list;
  });
  ipcMain.handle("skills:reveal", (_event, dir: string) => shell.showItemInFolder(dir));
  ipcMain.handle("skills:read", (_event, dir: string) => readSkillFile(dir, defaultWorkspace()));

  // ── settings ──────────────────────────────────────────────────────────────
  const settingsSnapshot = () => ({
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
  ipcMain.handle("settings:get", () => settingsSnapshot());
  ipcMain.handle("settings:setTheme", (_event, theme: ThemeSetting) => {
    const next = theme === "light" || theme === "dark" ? theme : "system";
    appSettings.update({ theme: next });
    applyTheme(next);
    return settingsSnapshot();
  });
  ipcMain.handle("settings:setLaunchAtLogin", (_event, enabled: boolean) => {
    appSettings.update({ launchAtLogin: enabled === true });
    applyLaunchAtLogin(enabled === true);
    return settingsSnapshot();
  });
  ipcMain.handle("workspace:choose", async () => {
    const picked = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"],
      title: "选择新会话使用的工作目录",
    });
    if (picked.canceled || picked.filePaths.length === 0) return settingsSnapshot();
    setDefaultWorkspace(picked.filePaths[0]);
    return settingsSnapshot();
  });
  ipcMain.handle("workspace:reset", () => {
    setDefaultWorkspace(null);
    return settingsSnapshot();
  });
  ipcMain.handle("path:reveal", (_event, path: string) => {
    if (typeof path === "string" && path) void shell.openPath(path);
  });

  ipcMain.handle("agent:setThinkingLevel", (_event, sessionId: string, level: string) => {
    if (typeof level !== "string") return false;
    // Recorded even without a worker; it is applied when the session next runs.
    if (!sessionId || drafts.holds(sessionId)) {
      drafts.chooseThinkingLevel(sessionId, level);
    } else {
      store.setThinkingLevel(sessionId, level);
      hostFor(sessionId)?.setThinkingLevel(level);
    }
    return true;
  });

  ipcMain.handle("agent:setModel", (_event, sessionId: string, provider: string, model: string) => {
    if (typeof provider !== "string" || typeof model !== "string") return false;
    if (!sessionId || drafts.holds(sessionId)) {
      drafts.chooseModel(sessionId, { provider, id: model });
    } else {
      store.setModel(sessionId, provider, model);
      hostFor(sessionId)?.setModel(provider, model);
    }
    return true;
  });

  // The renderer answers a dialog: `key` identifies the waiting promise here,
  // `requestId`/`answer` are forwarded to the worker.
  // The renderer answers a dialog. The pending promise in `askUser` resolves and
  // `AgentHost` writes the `extension_ui_response` back to pi.
  ipcMain.handle("agent:answer", (_event, payload: { requestId: string; answer: UiAnswer }) => {
    const resolvePending = pendingDialogs.get(payload.requestId);
    if (!resolvePending) return false;
    pendingDialogs.delete(payload.requestId);
    resolvePending(payload.answer);
    return true;
  });
}

/** The session the app opens with: the last active one, else a fresh one. */
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
  // Models and skills are read at startup, so every live conversation restarts.
  await Promise.all([...hosts.values()].map((live) => live.restart().catch(() => undefined)));
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
 * Point the agent at another directory.
 *
 * Sessions are per workspace (pi scopes them to the cwd), so the whole session
 * store is swapped: the old workspace's list stays on disk untouched.
 */
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
      if (sessionFile && existsSync(sessionFile)) store.attachFile(sessionId, sessionFile);
    },
    askUser,
    onRestart: (info) => {
      logger.error("worker restarted", { sessionId, ...info });
      // A crashed worker will never send `settled`; without this the app would
      // think a turn is still running and ask before every quit.
      workingSessions.delete(sessionId);
      // The turn died with the worker: settle it so the view stops showing a
      // spinner, then say why in the transcript.
      send("agent:event", { type: "settled", sessionId });
      send("agent:event", { type: "notify", message: `worker 已重启（第 ${info.attempt} 次）`, sessionId });
    },
  });
  hosts.set(sessionId, started);
  logger.debug("worker started", { sessionId, pid: started.workerPid });
  return started;
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
    applyTheme(appSettings.value.theme);
    applyLaunchAtLogin(appSettings.value.launchAtLogin);
    registerAppProtocol();
    registerIpc();
    createWindow();
    createTray();
    // No worker at launch unless a saved conversation has to be shown: its
    // transcript lives in pi's hands, so only pi can produce it. A draft starts
    // no process at all.
    // Nothing is started here: the conversation list, the transcript and the
    // model catalogue all come from disk, and pi starts on the first message.
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
    send("agent:ready", { sessionId: null, model: resolveDefaultModel()?.id ?? null });
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
    quitting = true;
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
  // Not awaited on purpose: pi exits by itself when its stdin closes, so even if
  // the app disappears first nothing is left running. This is the polite path.
  for (const live of hosts.values()) void live.dispose();
  hosts.clear();
  void quitting;
});
