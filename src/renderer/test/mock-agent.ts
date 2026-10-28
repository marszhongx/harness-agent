/**
 * A stand-in for the preload bridge.
 *
 * Components talk to `window.agent` and nothing else, so the whole IPC surface
 * can be replaced with spies. Event/dialog subscriptions are kept so a test can
 * push a message the way the worker would.
 */
import { vi } from "vitest";
import type {
  AgentApi,
  AgentEvent,
  AgentStatus,
  DialogRequest,
  ModelInfo,
  SessionSummary,
  SettingsSnapshot,
  SkillSummary,
  TranscriptItem,
} from "../lib/agent";

export interface MockAgent {
  api: AgentApi;
  emitEvent: (event: AgentEvent) => void;
  emitDialog: (dialog: DialogRequest, sessionId?: string) => void;
  emitReady: (payload: { sessionId: string | null; model: string | null }) => void;
}

const status = (overrides: Partial<AgentStatus> = {}): AgentStatus => ({
  sessionId: "session-1",
  piSessionId: "harness-agent-session-1",
  sessionFile: null,
  model: "glm-5.3-flash",
  workspacePath: "/tmp/workspace",
  working: false,
  workerPid: 1,
  ...overrides,
});

const settings = (overrides: Partial<SettingsSnapshot> = {}): SettingsSnapshot => ({
  theme: "system",
  launchAtLogin: false,
  workspacePath: "/tmp/workspace",
  workspaceIsCustom: false,
  dataDir: "/tmp/data",
  sessionsDir: "/tmp/data/sessions",
  logsDir: "/tmp/data/logs",
  appName: "harness-agent",
  appVersion: "0.0.0",
  electronVersion: "40.0.0",
  nodeVersion: "24.0.0",
  ...overrides,
});

const session = (overrides: Partial<SessionSummary> = {}): SessionSummary => ({
  id: "session-1",
  title: "第一个会话",
  updatedAt: Date.now(),
  ...overrides,
});

export interface MockOptions {
  models?: ModelInfo[];
  defaultModel?: { provider: string; id: string } | null;
  sessions?: SessionSummary[];
  /** Thinking level pi would use when nobody picked one. */
  defaultThinkingLevel?: string;
  status?: Partial<AgentStatus>;
  history?: TranscriptItem[];
  settings?: Partial<SettingsSnapshot>;
  providers?: Array<{
    id: string;
    baseUrl: string;
    api: string;
    hasKey: boolean;
    models: Array<{ id: string; name: string; contextWindow?: number }>;
  }>;
  skills?: SkillSummary[];
  /** What a skill's SKILL.md contains, for the details dialog. */
  skillText?: string;
}

export function installMockAgent(options: MockOptions = {}): MockAgent {
  const eventListeners: Array<(event: AgentEvent) => void> = [];
  const dialogListeners: Array<
    (payload: { sessionId: string; requestId: string; dialog: DialogRequest }) => void
  > = [];
  const readyListeners: Array<(payload: { sessionId: string | null; model: string | null }) => void> = [];

  const sessions = options.sessions ?? [session()];
  const defaultSessionId = options.status?.sessionId ?? "session-1";
  /**
   * Events are tagged with the conversation the component last touched, the way
   * the real app tags them with the session that produced them.
   */
  let eventSessionId = defaultSessionId;
  const remember = (sessionId?: string) => {
    if (typeof sessionId === "string" && sessionId) eventSessionId = sessionId;
  };
  let dialogSeq = 0;

  const api: AgentApi = {
    status: vi.fn(async (sessionId?: string) => {
      remember(sessionId);
      return status({ ...options.status, sessionId: sessionId ?? defaultSessionId });
    }),
    history: vi.fn(async () => options.history ?? []),
    models: vi.fn(async () => options.models ?? []),
    setModel: vi.fn(async () => true),
    defaultModel: vi.fn(async () => options.defaultModel ?? null),
    defaultThinkingLevel: vi.fn(async () => options.defaultThinkingLevel ?? "max"),
    setDefaultModel: vi.fn(async (provider: string, id: string) => ({ provider, id })),
    modelsList: vi.fn(async () => options.providers ?? []),
    saveProvider: vi.fn(async () => undefined),
    removeProvider: vi.fn(async () => undefined),
    addModel: vi.fn(async () => undefined),
    removeModel: vi.fn(async () => undefined),
    skillsList: vi.fn(async () => options.skills ?? []),
    removeSkill: vi.fn(async () => undefined),
    revealSkill: vi.fn(async () => undefined),
    readSkill: vi.fn(async () => options.skillText ?? "---\nname: pdf-tools\n---\n\n# body\n"),
    settings: vi.fn(async () => settings(options.settings)),
    setTheme: vi.fn(async () => settings(options.settings)),
    setLaunchAtLogin: vi.fn(async () => settings(options.settings)),
    chooseWorkspace: vi.fn(async () => settings(options.settings)),
    resetWorkspace: vi.fn(async () => settings(options.settings)),
    revealPath: vi.fn(async () => undefined),
    prompt: vi.fn(async (sessionId: string) => {
      remember(sessionId);
      return "request-1";
    }),
    setThinkingLevel: vi.fn(async () => true),
    abort: vi.fn(async () => undefined),
    chooseDraftWorkspace: vi.fn(async () => ({ workspacePath: "/tmp/picked-workspace" })),
    newSession: vi.fn(async () => {
      eventSessionId = "draft-1";
      return "draft-1";
    }),
    listSessions: vi.fn(async () => sessions),
    deleteSession: vi.fn(async (sessionId: string) => sessions.filter((entry) => entry.id !== sessionId)),
    answer: vi.fn(async () => true),
    onEvent: (handler) => {
      eventListeners.push(handler);
      return () => undefined;
    },
    onDialog: (handler) => {
      dialogListeners.push(handler);
      return () => undefined;
    },
    onReady: (handler) => {
      readyListeners.push(handler);
      return () => undefined;
    },
  };

  window.agent = api;

  return {
    api,
    emitEvent: (event) => {
      // Real events are tagged with their conversation; default to this one.
      const tagged = { sessionId: eventSessionId, ...event } as AgentEvent;
      for (const listener of eventListeners) listener(tagged);
    },
    emitDialog: (dialog, sessionId = eventSessionId) => {
      const payload = { sessionId, requestId: `dialog-${++dialogSeq}`, dialog };
      for (const listener of dialogListeners) listener(payload);
    },
    emitReady: (payload) => {
      for (const listener of readyListeners) listener(payload);
    },
  };
}
