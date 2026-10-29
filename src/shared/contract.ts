/**
 * The renderer <-> main contract.
 *
 * One source for main, preload, and renderer types. Host domain types are
 * re-exported instead of copied; shapes that only exist on the bridge live
 * here. Every import and export in this file is type-only, so importing it
 * costs nothing at runtime.
 */
import type { ProviderSummary } from "../host/models-config.ts";
import type { DialogRequest, ModelInfo, PromptImage, TranscriptItem, UiAnswer } from "../host/protocol.ts";
import type { SkillSummary } from "../host/skills.ts";

export type {
  DialogRequest,
  ModelInfo,
  PromptImage,
  ProviderSummary,
  SkillSummary,
  TranscriptItem,
  UiAnswer,
};

export interface SessionSummary {
  id: string;
  title: string;
  updatedAt: number;
  /** Transcript file name, once pi has written one. */
  sessionFile?: string;
  /** What this conversation last ran with, if it ever ran. */
  model?: { provider: string; id: string };
  thinkingLevel?: string;
  /** A turn is in flight for this conversation right now. */
  working?: boolean;
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

export interface AgentStatus {
  sessionId: string;
  piSessionId: string | null;
  sessionFile: string | null;
  model: string | null;
  workspacePath: string | null;
  working: boolean;
  workerPid: number | null;
}

/** The one-off result of a model connectivity check; never persisted. */
export interface ModelProbe {
  ok: boolean;
  reply?: string;
  error?: string;
}

export interface AgentEvent {
  type: string;
  [key: string]: unknown;
}

/** The whole preload surface, as the renderer sees it. */
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
  testModel: (provider: string, model: string) => Promise<ModelProbe>;
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
