/**
 * Preload: the only bridge between the renderer and the agent.
 *
 * Everything is an explicit channel. The renderer gets no Node access, no
 * filesystem, no credentials, and no way to reach pi directly.
 */
import { contextBridge, ipcRenderer } from "electron";

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
    ipcRenderer.invoke("agent:status", sessionId) as Promise<{
      sessionId: string | null;
      piSessionId: string | null;
      model: string | null;
      workspacePath: string | null;
      working: boolean;
      thinkingLevel?: string;
      workerPid: number | null;
    }>,
  history: (sessionId?: string) =>
    ipcRenderer.invoke("agent:history", sessionId) as Promise<TranscriptItem[] | null>,
  models: () => ipcRenderer.invoke("agent:models") as Promise<ModelInfo[]>,
  defaultModel: () => ipcRenderer.invoke("agent:defaultModel") as Promise<{ provider: string; id: string }>,
  setDefaultModel: (provider: string, id: string) =>
    ipcRenderer.invoke("agent:setDefaultModel", provider, id) as Promise<{ provider: string; id: string }>,
  setModel: (sessionId: string | null, provider: string, model: string) =>
    ipcRenderer.invoke("agent:setModel", sessionId, provider, model) as Promise<boolean>,
  prompt: (sessionId: string, message: string, images?: Array<{ data: string; mimeType: string }>) =>
    ipcRenderer.invoke("agent:prompt", sessionId, message, images) as Promise<string | null>,
  setThinkingLevel: (sessionId: string | null, level: string) =>
    ipcRenderer.invoke("agent:setThinkingLevel", sessionId, level) as Promise<boolean>,
  abort: (sessionId: string) => ipcRenderer.invoke("agent:abort", sessionId) as Promise<void>,
  newSession: () => ipcRenderer.invoke("agent:newSession") as Promise<string>,
  chooseDraftWorkspace: () =>
    ipcRenderer.invoke("agent:chooseDraftWorkspace") as Promise<{ workspacePath: string }>,
  listSessions: () => ipcRenderer.invoke("agent:listSessions") as Promise<SessionSummary[]>,
  deleteSession: (sessionId: string) =>
    ipcRenderer.invoke("agent:deleteSession", sessionId) as Promise<SessionSummary[]>,
  // ── models ────────────────────────────────────────────────────────────────
  modelsList: () => ipcRenderer.invoke("models:list") as Promise<ProviderSummary[]>,
  saveProvider: (id: string, input: { baseUrl: string; api: string; apiKey?: string }) =>
    ipcRenderer.invoke("models:upsertProvider", id, input) as Promise<ProviderSummary[]>,
  removeProvider: (id: string) =>
    ipcRenderer.invoke("models:removeProvider", id) as Promise<ProviderSummary[]>,
  addModel: (providerId: string, model: { id: string; name?: string; contextWindow?: number }) =>
    ipcRenderer.invoke("models:addModel", providerId, model) as Promise<ProviderSummary[]>,
  removeModel: (providerId: string, modelId: string) =>
    ipcRenderer.invoke("models:removeModel", providerId, modelId) as Promise<ProviderSummary[]>,

  // ── skills ────────────────────────────────────────────────────────────────
  skillsList: () => ipcRenderer.invoke("skills:list") as Promise<SkillSummary[]>,
  removeSkill: (dir: string) => ipcRenderer.invoke("skills:remove", dir) as Promise<SkillSummary[]>,
  revealSkill: (dir: string) => ipcRenderer.invoke("skills:reveal", dir) as Promise<void>,
  readSkill: (dir: string) => ipcRenderer.invoke("skills:read", dir) as Promise<string | null>,

  // ── settings ──────────────────────────────────────────────────────────────
  settings: () => ipcRenderer.invoke("settings:get") as Promise<SettingsSnapshot>,
  setTheme: (theme: "system" | "light" | "dark") =>
    ipcRenderer.invoke("settings:setTheme", theme) as Promise<SettingsSnapshot>,
  setLaunchAtLogin: (enabled: boolean) =>
    ipcRenderer.invoke("settings:setLaunchAtLogin", enabled) as Promise<SettingsSnapshot>,
  chooseWorkspace: () => ipcRenderer.invoke("workspace:choose") as Promise<SettingsSnapshot>,
  resetWorkspace: () => ipcRenderer.invoke("workspace:reset") as Promise<SettingsSnapshot>,
  revealPath: (path: string) => ipcRenderer.invoke("path:reveal", path) as Promise<void>,

  onEvent: (handler: (message: Record<string, unknown>) => void) => subscribe("agent:event", handler),
  answer: (requestId: string, value: UiAnswer) =>
    ipcRenderer.invoke("agent:answer", { requestId, answer: value }) as Promise<boolean>,

  onDialog: (handler: (payload: { requestId: string; dialog: Dialog }) => void) =>
    subscribe("agent:dialog", handler),
  onReady: (handler: (payload: { sessionId: string | null; model: string | null }) => void) =>
    subscribe("agent:ready", handler),
};

contextBridge.exposeInMainWorld("agent", api);

export type AgentApi = typeof api;
