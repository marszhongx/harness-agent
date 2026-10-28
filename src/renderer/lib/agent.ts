/**
 * The renderer's view of the preload bridge.
 *
 * Everything here is a mirror of `src/preload/index.ts`. The renderer has no
 * Node access, so this file is the whole surface the UI can reach.
 */

export interface ModelInfo {
  provider: string;
  id: string;
  name: string;
  contextWindow?: number;
  reasoning?: boolean;
  /** A level mapped to `null` is not available for this model. */
  thinkingLevelMap?: Record<string, string | null>;
}

export interface PromptImage {
  data: string;
  mimeType: string;
}

export type TranscriptItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; name: string; summary?: string; text?: string; isError?: boolean };

export interface SessionSummary {
  id: string;
  title: string;
  updatedAt: number;
  model?: { provider: string; id: string };
  /** A turn is in flight for this conversation right now. */
  working?: boolean;
  /** What this conversation last ran with, if it ever ran. */
  thinkingLevel?: string;
}

export interface SettingsSnapshot {
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

export interface ProviderSummary {
  id: string;
  baseUrl: string;
  api: string;
  hasKey: boolean;
  models: Array<{ id: string; name: string; contextWindow?: number }>;
}

export interface SkillSummary {
  name: string;
  description: string;
  dir: string;
  scope: "project" | "user";
  manualOnly: boolean;
}

export type UiAnswer =
  | { kind: "confirm"; confirmed: boolean }
  | { kind: "value"; value: string }
  | { kind: "cancel" };

export interface DialogRequest {
  method: "confirm" | "select" | "input" | "editor";
  title: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
}

export interface AgentEvent {
  type: string;
  [key: string]: unknown;
}

export interface AgentStatus {
  sessionId: string | null;
  piSessionId: string | null;
  sessionFile: string | null;
  model: string | null;
  workspacePath: string | null;
  working: boolean;
  workerPid: number | null;
}

export interface AgentApi {
  status: (sessionId?: string) => Promise<AgentStatus>;
  history: (sessionId?: string) => Promise<TranscriptItem[] | null>;
  models: () => Promise<ModelInfo[]>;
  setModel: (sessionId: string | null, provider: string, model: string) => Promise<boolean>;
  defaultModel: () => Promise<{ provider: string; id: string } | null>;
  /** Thinking level a conversation starts with on this machine. */
  defaultThinkingLevel: () => Promise<string>;
  setDefaultModel: (provider: string, id: string) => Promise<{ provider: string; id: string } | null>;
  modelsList: () => Promise<ProviderSummary[]>;
  saveProvider: (id: string, input: { baseUrl: string; api: string; apiKey?: string }) => Promise<void>;
  removeProvider: (id: string) => Promise<void>;
  addModel: (
    providerId: string,
    model: { id: string; name?: string; contextWindow?: number },
  ) => Promise<void>;
  removeModel: (providerId: string, modelId: string) => Promise<void>;
  skillsList: () => Promise<SkillSummary[]>;
  removeSkill: (dir: string) => Promise<void>;
  revealSkill: (dir: string) => Promise<void>;
  /** The whole SKILL.md, for the details dialog. */
  readSkill: (dir: string) => Promise<string | null>;
  settings: () => Promise<SettingsSnapshot>;
  setTheme: (theme: "system" | "light" | "dark") => Promise<SettingsSnapshot>;
  setLaunchAtLogin: (enabled: boolean) => Promise<SettingsSnapshot>;
  chooseWorkspace: () => Promise<SettingsSnapshot>;
  resetWorkspace: () => Promise<SettingsSnapshot>;
  revealPath: (path: string) => Promise<void>;
  prompt: (sessionId: string, message: string, images?: PromptImage[]) => Promise<string | null>;
  setThinkingLevel: (sessionId: string | null, level: string) => Promise<boolean>;
  abort: (sessionId: string) => Promise<void>;
  newSession: () => Promise<string>;
  /** Choose the folder for the conversation that is about to start. */
  chooseDraftWorkspace: () => Promise<{ workspacePath: string }>;
  listSessions: () => Promise<SessionSummary[]>;
  /** Delete a conversation, its transcript included. Returns the new list. */
  deleteSession: (sessionId: string) => Promise<SessionSummary[]>;
  answer: (requestId: string, answer: UiAnswer) => Promise<boolean>;
  onEvent: (handler: (message: AgentEvent) => void) => () => void;
  onDialog: (
    handler: (payload: { sessionId: string; requestId: string; dialog: DialogRequest }) => void,
  ) => () => void;
  onReady: (handler: (payload: { sessionId: string | null; model: string | null }) => void) => () => void;
}

declare global {
  interface Window {
    agent: AgentApi;
  }
}

export const agent = (): AgentApi => window.agent;

/** `2026-10-24T11-13-05-045Z...` or a plain timestamp, rendered for humans. */
export function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  const date = new Date(ms);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

export function baseName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.at(-1) ?? path;
}
