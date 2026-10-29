/**
 * Wire protocol between the Electron main process and the agent worker.
 *
 * The worker owns the pi child process and nothing else: no windows, no disk
 * policy, no secrets. Everything it needs arrives in the `init` message, and
 * everything the UI needs leaves as an event. That keeps the crash surface of
 * the agent loop away from the app shell.
 */

/** Messages the main process sends to the worker. */
export type HostToWorker =
  | {
      type: "init";
      cliPath: string;
      cwd: string;
      /** Host-owned session id; one per session. */
      sessionId?: string;
      sessionDir?: string;
      sessionName?: string;
      /** Where the worker appends its own log lines; omitted means none. */
      logDir?: string;
      provider?: string;
      model?: string;
      thinkingLevel?: string;
      extraArgs?: string[];
      env?: Record<string, string>;
    }
  | { type: "prompt"; requestId: string; message: string; images?: PromptImage[] }
  | { type: "set_thinking_level"; level: string }
  | { type: "abort" }
  | { type: "set_model"; provider: string; model: string }
  /** The renderer's answer to a dialog request the worker forwarded. */
  | { type: "ui_response"; requestId: string; answer: UiAnswer }
  | { type: "shutdown" };

/**
 * One line of a restored transcript. pi keeps far more than the UI needs to
 * redraw a session's transcript, so the worker flattens it rather than shipping
 * raw agent messages across the wire.
 */
/** An image attached to a prompt, base64 already. */
export interface PromptImage {
  data: string;
  mimeType: string;
}

export type TranscriptItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; name: string; summary?: string; text?: string; isError?: boolean };

/** A model the agent can be switched to. */
export interface ModelInfo {
  provider: string;
  id: string;
  name: string;
  contextWindow?: number;
  reasoning?: boolean;
  /** A level mapped to `null` is not available for this model. */
  thinkingLevelMap?: Record<string, string | null>;
}

/** Messages the worker sends to the main process. */
export type WorkerToHost =
  /** `piSessionId` is pi's spelling; the host maps it to its own id upstream. */
  | { type: "ready"; piSessionId: string; sessionFile?: string; provider?: string; model?: string }
  /** Models the agent may be switched to; refreshed on every spawn. */
  | { type: "models"; models: ModelInfo[] }
  /** Sent when the model changes, from `set_model` or from pi itself. */
  | { type: "model"; provider: string; id: string }
  /** Thinking level in force, plus the levels this model supports. */
  | { type: "thinking"; level: string; levels: string[] }
  | { type: "prompt_accepted"; requestId: string; disposition: string }
  | { type: "text_delta"; requestId: string; delta: string }
  | { type: "thinking_delta"; requestId: string; delta: string }
  | {
      type: "tool_start";
      requestId: string;
      toolName: string;
      toolCallId?: string;
      /** One-line rendering of the arguments, computed worker-side. */
      summary?: string;
    }
  /** Output that arrived while the tool is still running. */
  | { type: "tool_update"; requestId: string; toolCallId?: string; text: string }
  | {
      type: "tool_end";
      requestId: string;
      toolName: string;
      toolCallId?: string;
      isError?: boolean;
      text?: string;
      durationMs?: number;
    }
  | { type: "status"; statusKey: string; text?: string }
  | { type: "notify"; level: "info" | "warning" | "error"; message: string }
  | { type: "settled"; requestId: string; reason: "agent_end" | "agent_settled"; willRetry: boolean }
  /** `turnEnded` is true when this error means the prompt's turn is over. */
  | { type: "error"; requestId?: string; message: string; fatal: boolean; turnEnded?: boolean }
  | { type: "ui_request"; requestId: string; request: DialogRequest };

/** A blocking dialog request the renderer must answer. */
export type DialogRequest =
  | { method: "confirm"; title: string; message: string; timeout?: number }
  | { method: "select"; title: string; options: string[]; timeout?: number }
  | { method: "input"; title: string; placeholder?: string; timeout?: number }
  | { method: "editor"; title: string; prefill?: string };

/** The renderer's answer to a dialog request. */
export type UiAnswer =
  | { kind: "confirm"; confirmed: boolean }
  | { kind: "value"; value: string }
  | { kind: "cancel" };
