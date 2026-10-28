/**
 * Preload: the only bridge between the renderer and the agent.
 *
 * Everything is an explicit channel. The renderer gets no Node access, no
 * filesystem, no credentials, and no way to reach pi directly.
 */
import { contextBridge, ipcRenderer } from "electron";
import { IpcAction } from "./ipc-action.ts";

type UiAnswer =
  | { kind: "confirm"; confirmed: boolean }
  | { kind: "value"; value: string }
  | { kind: "cancel" };

interface Dialog {
  method: "confirm" | "select" | "input" | "editor";
  title: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
}

interface SessionSummary {
  id: string;
  title: string;
  updatedAt: number;
  sessionFile?: string;
  /** A turn is in flight for this conversation right now. */
  working?: boolean;
  /** What this conversation last ran with, if it ever ran. */
  thinkingLevel?: string;
}

interface ModelInfo {
  provider: string;
  id: string;
  name: string;
  contextWindow?: number;
}

interface ProviderSummary {
  id: string;
  baseUrl: string;
  api: string;
  hasKey: boolean;
  models: Array<{ id: string; name: string; contextWindow?: number }>;
}

interface SkillSummary {
  name: string;
  description: string;
  dir: string;
  scope: "project" | "user";
  manualOnly: boolean;
}

interface SettingsSnapshot {
  theme: "system" | "light" | "dark";
  launchAtLogin: boolean;
  workspacePath: string;
  workspaceIsCustom: boolean;
  dataDir: string;
  sessionsDir: string;
  logsDir: string;
  appName: string;
  appVersion: string;
  electronVersion: string;
  nodeVersion: string;
}

interface TranscriptItem {
  kind: "user" | "assistant" | "thinking" | "tool";
  text?: string;
  name?: string;
  summary?: string;
  isError?: boolean;
}

function subscribe<T>(channel: string, handler: (payload: T) => void): () => void {
  const listener = (_event: unknown, payload: T) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.off(channel, listener);
}

const api = {
  status: (sessionId?: string) =>
    ipcRenderer.invoke(IpcAction.agent.status, sessionId) as Promise<{
      sessionId: string | null;
      piSessionId: string | null;
      model: string | null;
      workspacePath: string | null;
      working: boolean;
      thinkingLevel?: string;
      workerPid: number | null;
    }>,
  history: (sessionId?: string) =>
    ipcRenderer.invoke(IpcAction.agent.history, sessionId) as Promise<TranscriptItem[] | null>,
  models: () => ipcRenderer.invoke(IpcAction.agent.models) as Promise<ModelInfo[]>,
  defaultModel: () =>
    ipcRenderer.invoke(IpcAction.agent.defaultModel) as Promise<{ provider: string; id: string }>,
  defaultThinkingLevel: () => ipcRenderer.invoke(IpcAction.agent.defaultThinkingLevel) as Promise<string>,
  setDefaultModel: (provider: string, id: string) =>
    ipcRenderer.invoke(IpcAction.agent.setDefaultModel, provider, id) as Promise<{
      provider: string;
      id: string;
    }>,
  setModel: (sessionId: string | null, provider: string, model: string) =>
    ipcRenderer.invoke(IpcAction.agent.setModel, sessionId, provider, model) as Promise<boolean>,
  prompt: (sessionId: string, message: string, images?: Array<{ data: string; mimeType: string }>) =>
    ipcRenderer.invoke(IpcAction.agent.prompt, sessionId, message, images) as Promise<string | null>,
  setThinkingLevel: (sessionId: string | null, level: string) =>
    ipcRenderer.invoke(IpcAction.agent.setThinkingLevel, sessionId, level) as Promise<boolean>,
  abort: (sessionId: string) => ipcRenderer.invoke(IpcAction.agent.abort, sessionId) as Promise<void>,
  newSession: () => ipcRenderer.invoke(IpcAction.agent.newSession) as Promise<string>,
  chooseDraftWorkspace: () =>
    ipcRenderer.invoke(IpcAction.agent.chooseDraftWorkspace) as Promise<{ workspacePath: string }>,
  listSessions: () => ipcRenderer.invoke(IpcAction.agent.listSessions) as Promise<SessionSummary[]>,
  deleteSession: (sessionId: string) =>
    ipcRenderer.invoke(IpcAction.agent.deleteSession, sessionId) as Promise<SessionSummary[]>,
  // ── models ────────────────────────────────────────────────────────────────
  modelsList: () => ipcRenderer.invoke(IpcAction.models.list) as Promise<ProviderSummary[]>,
  saveProvider: (id: string, input: { baseUrl: string; api: string; apiKey?: string }) =>
    ipcRenderer.invoke(IpcAction.models.upsertProvider, id, input) as Promise<void>,
  removeProvider: (id: string) => ipcRenderer.invoke(IpcAction.models.removeProvider, id) as Promise<void>,
  addModel: (providerId: string, model: { id: string; name?: string; contextWindow?: number }) =>
    ipcRenderer.invoke(IpcAction.models.addModel, providerId, model) as Promise<void>,
  removeModel: (providerId: string, modelId: string) =>
    ipcRenderer.invoke(IpcAction.models.removeModel, providerId, modelId) as Promise<void>,

  // ── skills ────────────────────────────────────────────────────────────────
  skillsList: () => ipcRenderer.invoke(IpcAction.skills.list) as Promise<SkillSummary[]>,
  removeSkill: (dir: string) => ipcRenderer.invoke(IpcAction.skills.remove, dir) as Promise<void>,
  revealSkill: (dir: string) => ipcRenderer.invoke(IpcAction.skills.reveal, dir) as Promise<void>,
  readSkill: (dir: string) => ipcRenderer.invoke(IpcAction.skills.read, dir) as Promise<string | null>,

  // ── settings ──────────────────────────────────────────────────────────────
  settings: () => ipcRenderer.invoke(IpcAction.settings.get) as Promise<SettingsSnapshot>,
  setTheme: (theme: "system" | "light" | "dark") =>
    ipcRenderer.invoke(IpcAction.settings.setTheme, theme) as Promise<SettingsSnapshot>,
  setLaunchAtLogin: (enabled: boolean) =>
    ipcRenderer.invoke(IpcAction.settings.setLaunchAtLogin, enabled) as Promise<SettingsSnapshot>,
  chooseWorkspace: () => ipcRenderer.invoke(IpcAction.workspace.choose) as Promise<SettingsSnapshot>,
  resetWorkspace: () => ipcRenderer.invoke(IpcAction.workspace.reset) as Promise<SettingsSnapshot>,
  revealPath: (path: string) => ipcRenderer.invoke(IpcAction.path.reveal, path) as Promise<void>,

  onEvent: (handler: (message: Record<string, unknown>) => void) => subscribe(IpcAction.agent.event, handler),
  answer: (requestId: string, value: UiAnswer) =>
    ipcRenderer.invoke(IpcAction.agent.answer, { requestId, answer: value }) as Promise<boolean>,

  onDialog: (handler: (payload: { sessionId: string; requestId: string; dialog: Dialog }) => void) =>
    subscribe(IpcAction.agent.dialog, handler),
  onReady: (handler: (payload: { sessionId: string | null; model: string | null }) => void) =>
    subscribe(IpcAction.agent.ready, handler),
};

contextBridge.exposeInMainWorld("agent", api);

export type AgentApi = typeof api;
