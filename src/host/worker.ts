/**
 * Agent worker entry point.
 *
 * Runs as an Electron `utilityProcess` (or a plain forked Node child during
 * development) and is the only place a pi process exists. It maps pi's JSONL
 * session events onto the small wire contract in `protocol.ts`, and turns
 * extension dialogs into request/response round trips with the UI.
 */
import { initLogger, logger } from "./logger.ts";
import { PiTransport, type SessionEvent, type UiRequest } from "./pi-transport.ts";
import type { DialogRequest, HostToWorker, UiAnswer, WorkerToHost } from "./protocol.ts";
import { summarizeTool, toolResultText } from "./transcript.ts";

// ── channel: Electron utilityProcess or child_process.fork ───────────────────

interface Channel {
  onMessage(handler: (message: HostToWorker) => void): void;
  post(message: WorkerToHost): void;
}

function openChannel(): Channel {
  const parentPort = (
    process as unknown as {
      parentPort?: {
        on(event: "message", listener: (message: { data: HostToWorker }) => void): void;
        postMessage(message: WorkerToHost): void;
      };
    }
  ).parentPort;
  if (parentPort) {
    return {
      onMessage: (handler) => parentPort.on("message", (event) => handler(event.data)),
      post: (message) => parentPort.postMessage(message),
    };
  }
  // `process.send` on a closed channel does not throw: it emits an `error`
  // event on the process, which would take the worker down during shutdown.
  process.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "ERR_IPC_CHANNEL_CLOSED") return;
    throw error;
  });
  return {
    onMessage: (handler) => process.on("message", (raw) => handler(raw as HostToWorker)),
    post: (message) => {
      if (!process.connected) return;
      process.send?.(message);
    },
  };
}

// ── state ───────────────────────────────────────────────────────────────────

const channel = openChannel();

let transport: PiTransport | null = null;
let activeRequestId: string | null = null;
let settledWaiter: (() => void) | null = null;
/**
 * pi reports the end of a run twice when it emits both `agent_end` and
 * `agent_settled`. Only the first one is the end of the turn.
 */
let settledForRun = false;

const pendingDialogs = new Map<string, (answer: UiAnswer) => void>();
let dialogSeq = 0;
/** Levels the current model supports; resent with every level change. */
let thinkingLevels: string[] = [];

/** Extensions repaint status constantly; forward only real changes. */
const statusCache = new Map<string, string | undefined>();

function post(message: WorkerToHost): void {
  // The host can close the channel before the pi process finishes draining.
  // A late status repaint must not crash the worker.
  try {
    channel.post(message);
  } catch {
    // channel closed: the run is over, nothing left to report
  }
}

function fail(message: string, fatal: boolean, requestId?: string): void {
  post({ type: "error", message, fatal, requestId });
}

// ── event mapping ───────────────────────────────────────────────────────────

function onPiEvent(event: SessionEvent): void {
  const requestId = activeRequestId ?? "";

  switch (event.type) {
    case "message_update": {
      const inner = event.assistantMessageEvent as
        | { type?: string; delta?: string; toolName?: string; id?: string }
        | undefined;
      if (!inner?.delta) return;
      if (inner.type === "text_delta" && inner.delta) {
        post({ type: "text_delta", requestId, delta: inner.delta });
      } else if (inner.type === "thinking_delta" && inner.delta) {
        post({ type: "thinking_delta", requestId, delta: inner.delta });
      }
      // Tool starts come from `tool_execution_start` only. `toolcall_start` is the
      // model's announcement of the call; using both doubles every tool entry.
      return;
    }

    case "tool_execution_start": {
      const toolName = String(event.toolName ?? "tool");
      post({
        type: "tool_start",
        requestId,
        toolName,
        toolCallId: typeof event.toolCallId === "string" ? event.toolCallId : undefined,
        summary: summarizeTool(toolName, event.args),
      });
      return;
    }

    case "tool_execution_update": {
      const text = toolResultText(event.partialResult, 2000);
      if (!text) return;
      post({
        type: "tool_update",
        requestId,
        toolCallId: typeof event.toolCallId === "string" ? event.toolCallId : undefined,
        text,
      });
      return;
    }

    case "tool_execution_end": {
      post({
        type: "tool_end",
        requestId,
        toolName: String(event.toolName ?? "tool"),
        toolCallId: typeof event.toolCallId === "string" ? event.toolCallId : undefined,
        isError: event.isError === true,
        text: toolResultText(event.result),
        durationMs: typeof event.durationMs === "number" ? event.durationMs : undefined,
      });
      return;
    }

    case "thinking_level_changed": {
      const level = typeof event.thinkingLevel === "string" ? event.thinkingLevel : undefined;
      if (level) post({ type: "thinking", level, levels: thinkingLevels });
      return;
    }

    case "model_select": {
      const model = event.model as { provider?: string; id?: string } | undefined;
      if (model?.provider && model.id) post({ type: "model", provider: model.provider, id: model.id });
      return;
    }

    case "agent_end":
    case "agent_settled": {
      const willRetry = event.willRetry === true;
      // `agent_end` is not terminal when a retry is queued.
      if (event.type === "agent_end" && willRetry) return;
      if (settledForRun) return;
      settledForRun = true;
      post({ type: "settled", requestId, reason: event.type, willRetry });
      settledWaiter?.();
      settledWaiter = null;
      return;
    }

    default:
      return;
  }
}

function toDialog(request: UiRequest): DialogRequest | null {
  switch (request.method) {
    case "confirm":
      return { method: "confirm", title: request.title, message: request.message, timeout: request.timeout };
    case "select":
      return { method: "select", title: request.title, options: request.options, timeout: request.timeout };
    case "input":
      return {
        method: "input",
        title: request.title,
        placeholder: request.placeholder,
        timeout: request.timeout,
      };
    case "editor":
      return { method: "editor", title: request.title, prefill: request.prefill };
    default:
      return null;
  }
}

async function onUiRequest(
  request: UiRequest,
): Promise<
  | { type: "extension_ui_response"; id: string; confirmed: boolean }
  | { type: "extension_ui_response"; id: string; value: string }
  | { type: "extension_ui_response"; id: string; cancelled: true }
  | null
> {
  // Fire-and-forget methods never get a response written back.
  if (request.method === "notify") {
    post({ type: "notify", level: request.notifyType ?? "info", message: request.message });
    return null;
  }
  if (request.method === "setStatus") {
    if (statusCache.get(request.statusKey) === request.statusText) return null;
    statusCache.set(request.statusKey, request.statusText);
    post({ type: "status", statusKey: request.statusKey, text: request.statusText });
    return null;
  }
  if (
    request.method !== "confirm" &&
    request.method !== "select" &&
    request.method !== "input" &&
    request.method !== "editor"
  ) {
    return null;
  }

  const dialog = toDialog(request);
  if (!dialog) return null;

  const requestId = `d${++dialogSeq}`;
  const answer = await new Promise<UiAnswer>((resolve) => {
    pendingDialogs.set(requestId, resolve);
    post({ type: "ui_request", requestId, request: dialog });
    // Pi auto-resolves dialogs that carry a timeout; mirror that bound here so
    // the map cannot grow when a renderer never answers.
    const timeout = "timeout" in dialog ? dialog.timeout : undefined;
    if (typeof timeout === "number" && timeout > 0) {
      setTimeout(() => {
        if (!pendingDialogs.delete(requestId)) return;
        resolve({ kind: "cancel" });
      }, timeout);
    }
  });
  pendingDialogs.delete(requestId);

  if (answer.kind === "confirm") {
    return { type: "extension_ui_response", id: request.id, confirmed: answer.confirmed };
  }
  if (answer.kind === "value") {
    return { type: "extension_ui_response", id: request.id, value: answer.value };
  }
  return { type: "extension_ui_response", id: request.id, cancelled: true };
}

// ── command handling ────────────────────────────────────────────────────────

async function init(message: Extract<HostToWorker, { type: "init" }>): Promise<void> {
  if (transport) {
    fail("worker already initialised", false);
    return;
  }
  // Started before pi so startup failures land in the same file as the rest.
  if (message.logDir) {
    initLogger(message.logDir, { level: process.env.HARNESS_DEBUG ? "debug" : "info", tag: "worker" });
    process.on("uncaughtException", (error) => logger.error("uncaughtException", error));
    process.on("unhandledRejection", (reason) => logger.error("unhandledRejection", reason));
  }
  logger.info("worker init", {
    sessionId: message.sessionId,
    provider: message.provider,
    model: message.model,
    pid: process.pid,
  });
  try {
    transport = await PiTransport.start({
      cliPath: message.cliPath,
      cwd: message.cwd,
      sessionId: message.sessionId,
      sessionDir: message.sessionDir,
      sessionName: message.sessionName,
      provider: message.provider,
      model: message.model,
      thinkingLevel: message.thinkingLevel,
      extraArgs: message.extraArgs,
      env: message.env,
      onEvent: onPiEvent,
      onUiRequest,
      onStderr: (chunk) => {
        process.stderr.write(`[pi] ${chunk}`);
        logger.warn("pi stderr", chunk.trim());
      },
    });
    const state = await transport.getState();
    post({
      type: "ready",
      piSessionId: state.sessionId,
      sessionFile: state.sessionFile,
      // The model pi actually resolved, which is not always the one we asked for
      // (a session keeps its own, and the requested one may not be enabled).
      provider: (state.model as { provider?: string } | undefined)?.provider,
      model: (state.model as { id?: string } | undefined)?.id ?? message.model,
    });
    // Send the transcript right behind `ready`. Every spawn is either a fresh
    // session or a switch back to an existing one, and the renderer should
    // not have to ask which.
    // The catalogue is not asked for here: the main process derives it from
    // `models.json`, so a worker is never started just to fill a dropdown.
    logger.info("pi ready", { piSessionId: state.sessionId, sessionFile: state.sessionFile });
    const levels = await transport.getThinkingLevels().catch(() => ({ levels: [] as string[] }));
    thinkingLevels = levels.levels;
    post({ type: "thinking", level: String(state.thinkingLevel ?? "medium"), levels: thinkingLevels });
  } catch (error) {
    logger.error("worker init failed", error);
    fail(error instanceof Error ? error.message : String(error), true);
  }
}

async function runPrompt(
  requestId: string,
  message: string,
  images?: Array<{ data: string; mimeType: string }>,
): Promise<void> {
  if (!transport) {
    fail("worker is not initialised", false, requestId);
    return;
  }
  if (activeRequestId) {
    fail("a run is already in flight", false, requestId);
    return;
  }
  activeRequestId = requestId;
  settledForRun = false;
  try {
    const accepted = await transport.prompt(message, images);
    post({ type: "prompt_accepted", requestId, disposition: accepted.disposition ?? "run" });
    await new Promise<void>((resolve) => {
      settledWaiter = resolve;
    });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error), false, requestId);
  } finally {
    activeRequestId = null;
    settledWaiter = null;
  }
}

channel.onMessage((message) => {
  void (async () => {
    switch (message.type) {
      case "init":
        await init(message);
        return;
      case "prompt":
        await runPrompt(message.requestId, message.message, message.images);
        return;
      case "set_thinking_level":
        try {
          await transport?.setThinkingLevel(message.level);
        } catch (error) {
          fail(error instanceof Error ? error.message : String(error), false);
        }
        return;
      case "abort":
        await transport?.abort().catch(() => undefined);
        return;
      case "set_model":
        try {
          const applied = await transport?.setModel(message.provider, message.model);
          if (applied) post({ type: "model", provider: message.provider, id: message.model });
        } catch (error) {
          fail(error instanceof Error ? error.message : String(error), false);
        }
        return;
      case "ui_response": {
        const resolve = pendingDialogs.get(message.requestId);
        if (resolve) {
          pendingDialogs.delete(message.requestId);
          resolve(message.answer);
        }
        return;
      }
      case "shutdown":
        // Stop pi first: unanswered dialogs and status repaints both try to
        // write to the channel, and both must be quiet before we exit.
        await transport?.dispose();
        transport = null;
        try {
          process.disconnect?.();
        } catch {
          // already disconnected
        }
        process.exit(0);
        return;
      default:
        return;
    }
  })();
});
