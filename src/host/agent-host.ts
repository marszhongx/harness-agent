/**
 * Main-process owner of the agent worker.
 *
 * Responsibilities, deliberately narrow:
 *   - start the worker (Electron `utilityProcess`, or a forked Node child in dev)
 *   - hand it the pi CLI path and model selection
 *   - route worker events upward and dialog answers downward
 *   - restart it when it dies, with backoff, without taking the app down
 *
 * The agent loop never runs in this process. A runaway `bash` call or a runaway
 * context is the worker's problem, and a crash costs one restart, not the app.
 */
import { type ChildProcess, fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { DialogRequest, HostToWorker, UiAnswer, WorkerToHost } from "./protocol.ts";
import { mintSessionId, toPiSessionId } from "./session-id.ts";

export interface AgentHostOptions {
  /** Compiled worker entry (`.js`, or `.ts` under node's type stripping). */
  workerEntry: string;
  piCliPath: string;
  cwd: string;
  /**
   * Transcript directory. Kept under our app data so app sessions never
   * mix with the user's own `~/.pi` sessions.
   */
  sessionDir: string;
  /** Id of the session to open first. Minted when omitted. */
  sessionId?: string;
  /**
   * Brand applied only when the id crosses into pi's namespace, so its session
   * directory stays readable by eye and one app's transcripts cannot be
   * mistaken for another's. Unset means ids are handed over bare.
   */
  sessionIdPrefix?: string;
  /** Display name written onto the session. */
  sessionName?: string;
  /** Directory for the worker's own log file; omitted means memory only. */
  logDir?: string;
  provider?: string;
  model?: string;
  thinkingLevel?: string;
  extraArgs?: string[];
  env?: Record<string, string>;
  /** Called for every worker event. The Electron main process forwards these to the renderer. */
  onEvent: (message: WorkerToHost) => void;
  /**
   * Called for dialogs that need a human. `requestId` is the worker's id; echo
   * it back through `answerDialog` only if this callback does not return an
   * answer itself.
   */
  askUser?: (requestId: string, dialog: DialogRequest) => Promise<UiAnswer> | UiAnswer;
  onRestart?: (info: { attempt: number; code: number | null; signal: string | null }) => void;
  /**
   * Called once per spawn, after the worker reports what pi opened. Separate
   * from `onEvent` because it fires *during* `AgentHost.start()` — before the
   * caller has a host reference to read `sessionId` from.
   */
  onReady?: (info: {
    sessionId: string;
    piSessionId: string;
    sessionFile: string | null;
    provider?: string;
    model?: string;
  }) => void;
  /** Time allowed between spawn and `ready` before the worker is considered wedged. */
  readyTimeoutMs?: number;
  /**
   * Time allowed for a turn to end after `abort()` before the worker is treated
   * as wedged and replaced. Stop has to work even when pi is not listening.
   */
  abortGraceMs?: number;
  maxRestarts?: number;
}

interface WorkerHandle {
  post(message: HostToWorker): void;
  onMessage(handler: (message: WorkerToHost) => void): void;
  onExit(handler: (code: number | null, signal: string | null) => void): void;
  kill(): void;
  readonly pid: number | undefined;
}

const DEFAULT_READY_TIMEOUT = 45_000;
const DEFAULT_ABORT_GRACE = 5_000;

export class AgentHost {
  #options: AgentHostOptions;
  #worker: WorkerHandle | null = null;
  #ready: Promise<void> | null = null;
  #restarts = 0;
  #disposed = false;
  /** What pi reported it opened; `null` until the worker is ready. */
  #piSessionId: string | null = null;
  #sessionFile: string | null = null;
  #model: string | null = null;
  /**
   * Serialises lifecycle work.
   *
   * Switching conversations is two restarts in quick succession when a user
   * clicks twice, and an overlapping restart posts `shutdown` to a worker that
   * has only just spawned — which looks like "worker exited during startup" and
   * sends recovery into another spawn. One operation at a time, in order.
   */
  #queue: Promise<unknown> = Promise.resolve();
  /**
   * Number of workers whose exit we are causing on purpose.
   *
   * Without this, killing a worker to switch conversations looks exactly like a
   * crash: the exit handler schedules a recovery spawn 500 ms later, and that
   * orphan worker lives beside the one the switch already started.
   */
  #expectedExits = 0;
  /** A turn is in flight: a prompt was accepted and no `settled` came back yet. */
  #inFlight = false;
  /** Set while we wait for an abort to take effect. */
  #abortTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Session id owned by the host, not by pi. Plain UUID; the branded form
   * is derived at the pi boundary by `#expectedPiSessionId`.
   */
  #sessionId: string;

  private constructor(options: AgentHostOptions) {
    this.#options = options;
    // Taken verbatim: the id is the caller's, and `#expectedPiSessionId` is
    // where the branded spelling gets derived.
    this.#sessionId = options.sessionId ?? mintSessionId();
  }

  static async start(options: AgentHostOptions): Promise<AgentHost> {
    const host = new AgentHost(options);
    await host.#spawn();
    return host;
  }

  /** Interior session id; what the UI and `sessions.json` carry. */
  get sessionId(): string {
    return this.#sessionId;
  }

  /** The id pi actually opened, branded form included. */
  get piSessionId(): string | null {
    return this.#piSessionId;
  }

  get sessionFile(): string | null {
    return this.#sessionFile;
  }

  get model(): string | null {
    return this.#model;
  }

  get workerPid(): number | undefined {
    return this.#worker?.pid;
  }

  /** Send a prompt. Resolves when pi accepts it; output arrives via `onEvent`. */
  async prompt(message: string, images?: Array<{ data: string; mimeType: string }>): Promise<string> {
    const requestId = randomUUID();
    await this.#ready;
    this.#post({ type: "prompt", requestId, message, images });
    this.#inFlight = true;
    return requestId;
  }

  /** Thinking level for this session; also becomes the default for later spawns. */
  setThinkingLevel(level: string): void {
    this.#options.thinkingLevel = level;
    this.#post({ type: "set_thinking_level", level });
  }

  answerDialog(requestId: string, answer: UiAnswer): void {
    this.#post({ type: "ui_response", requestId, answer });
  }

  /**
   * Stop this conversation's turn.
   *
   * Aborting is a request to pi, so it can be ignored — a wedged or busy worker
   * never answers. The host therefore keeps a deadline: when the turn is still
   * in flight after the grace period, the worker is replaced. That kills pi for
   * this conversation only; every other conversation keeps its own process.
   */
  abort(): void {
    if (!this.#inFlight) return;
    this.#post({ type: "abort" });
    if (this.#abortTimer) return;
    this.#abortTimer = setTimeout(() => {
      this.#abortTimer = null;
      if (!this.#inFlight || this.#disposed) return;
      this.#options.onEvent({
        type: "notify",
        level: "warning",
        message: "停止没有生效，正在重启这个会话的 worker",
      });
      this.#inFlight = false;
      void this.restart();
    }, this.#options.abortGraceMs ?? DEFAULT_ABORT_GRACE);
  }

  /** The turn ended — either pi said so, or the worker is gone. */
  #endTurn(): void {
    this.#inFlight = false;
    if (this.#abortTimer) {
      clearTimeout(this.#abortTimer);
      this.#abortTimer = null;
    }
  }

  /**
   * Switch the model on the live worker and remember it as the default for the
   * next spawn — a new session should inherit what the user just chose, not the
   * provider that happened to be in the environment at launch.
   */
  setModel(provider: string, model: string): void {
    this.#options.provider = provider;
    this.#options.model = model;
    this.#post({ type: "set_model", provider, model });
  }

  restart(): Promise<void> {
    return this.#enqueue(() => this.#restart());
  }

  #enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task, task);
    // Keep the chain alive even when a task rejects; the caller still sees it.
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #restart(): Promise<void> {
    this.#restarts = 0;
    const previous = this.#worker;
    if (previous) {
      this.#expectedExits += 1;
      try {
        previous.post({ type: "shutdown" });
      } catch {
        // already gone
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
      previous.kill();
      await new Promise((resolve) => setTimeout(resolve, 150));
      this.#worker = null;
    }
    await this.#spawn();
  }

  dispose(): Promise<void> {
    return this.#enqueue(() => this.#dispose());
  }

  async #dispose(): Promise<void> {
    this.#disposed = true;
    const worker = this.#worker;
    this.#worker = null;
    if (!worker) return;
    this.#expectedExits += 1;
    try {
      worker.post({ type: "shutdown" });
    } catch {
      // worker already gone
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    worker.kill();
  }

  // ── internals ─────────────────────────────────────────────────────────────

  #post(message: HostToWorker): void {
    if (!this.#worker) throw new Error("agent worker is not running");
    this.#worker.post(message);
  }

  /** The id pi sees: branded interior id. */
  #expectedPiSessionId(): string {
    return toPiSessionId(this.#sessionId, this.#options.sessionIdPrefix ?? "");
  }

  #spawn(): Promise<void> {
    // Resolvers are per-spawn closures, not instance fields. A restart replaces
    // `#ready`; if the outgoing worker's exit handler shared those fields it
    // would reject the *new* worker's startup with the old worker's SIGTERM.
    let resolveReady: (() => void) | null = null;
    let rejectReady: ((error: Error) => void) | null = null;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    // Startup failure is reported to the caller; swallow the unhandled rejection
    // when a restart path starts a worker nobody is waiting on directly.
    void ready.catch(() => undefined);
    this.#ready = ready;

    const worker = createWorker(this.#options.workerEntry);
    this.#worker = worker;

    const timer = setTimeout(() => {
      rejectReady?.(
        new Error(
          `agent worker did not become ready in ${this.#options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT}ms`,
        ),
      );
      worker.kill();
    }, this.#options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT);

    let settled = false;
    const settleReady = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
    };

    worker.onMessage((message) => {
      switch (message.type) {
        case "ready":
          this.#piSessionId = message.piSessionId;
          this.#sessionFile = message.sessionFile ?? null;
          this.#model = message.model ?? null;
          if (message.piSessionId !== this.#expectedPiSessionId()) {
            // pi answers with the id it actually opened. A mismatch means the
            // flag was dropped and the host's id no longer names the transcript.
            this.#options.onEvent({
              type: "error",
              message: `session id mismatch: asked ${this.#expectedPiSessionId()}, pi opened ${message.piSessionId}`,
              fatal: false,
            });
          }
          this.#options.onReady?.({
            sessionId: this.#sessionId,
            piSessionId: message.piSessionId,
            sessionFile: this.#sessionFile,
            provider: message.provider,
            model: message.model,
          });
          settleReady();
          resolveReady?.();
          break;
        case "model":
          // Keep the host's idea of the model current, so `status` does not
          // report the model from startup after the user has switched.
          this.#model = message.id;
          break;
        case "ui_request":
          void this.#handleDialog(message.requestId, message.request);
          break;
        case "error":
          if (message.fatal) {
            settleReady();
            rejectReady?.(new Error(message.message));
          }
          break;
        default:
          break;
      }
      if (message.type === "settled") this.#endTurn();
      this.#options.onEvent(message);
    });

    worker.onExit((code, signal) => {
      this.#endTurn();
      if (this.#disposed) {
        settleReady();
        return;
      }
      if (this.#expectedExits > 0) {
        this.#expectedExits -= 1;
        settleReady();
        return;
      }
      if (this.#worker !== worker) {
        // A worker that was already replaced is not the app's problem any more.
        settleReady();
        return;
      }
      // Only a worker that never became ready is a startup failure; a crash
      // after that is a restart, not a rejected promise.
      if (!settled)
        rejectReady?.(new Error(`agent worker exited during startup (code=${code}, signal=${signal})`));
      settleReady();
      void this.#recover(code, signal);
    });

    worker.post({
      type: "init",
      cliPath: this.#options.piCliPath,
      cwd: this.#options.cwd,
      sessionId: this.#expectedPiSessionId(),
      sessionDir: this.#options.sessionDir,
      sessionName: this.#options.sessionName,
      logDir: this.#options.logDir,
      provider: this.#options.provider,
      model: this.#options.model,
      thinkingLevel: this.#options.thinkingLevel,
      extraArgs: this.#options.extraArgs,
      env: this.#options.env,
    });

    return ready;
  }

  async #handleDialog(requestId: string, dialog: DialogRequest): Promise<void> {
    const answer = (await this.#options.askUser?.(requestId, dialog)) ?? { kind: "cancel" as const };
    this.answerDialog(requestId, answer);
  }

  async #recover(code: number | null, signal: string | null): Promise<void> {
    const max = this.#options.maxRestarts ?? 5;
    if (this.#restarts >= max) {
      this.#options.onEvent({
        type: "error",
        message: `agent worker crashed ${this.#restarts + 1} times; giving up`,
        fatal: true,
      });
      return;
    }
    this.#restarts += 1;
    const delay = Math.min(30_000, 500 * 2 ** (this.#restarts - 1));
    this.#options.onRestart?.({ attempt: this.#restarts, code, signal });
    await new Promise((resolve) => setTimeout(resolve, delay));
    if (this.#disposed) return;
    try {
      await this.#enqueue(() => this.#spawn());
    } catch {
      // #spawn's own exit handler drives the next attempt.
    }
  }
}

// ── worker construction ─────────────────────────────────────────────────────

function createWorker(entry: string): WorkerHandle {
  if (process.versions.electron) {
    return createUtilityProcess(entry);
  }
  return createForkedChild(entry);
}

function createForkedChild(entry: string): WorkerHandle {
  // `--experimental-strip-types` lets the same `.ts` worker run under plain Node
  // during development, without a build step.
  const child: ChildProcess = fork(entry, [], {
    execArgv: ["--experimental-strip-types", "--no-warnings"],
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  return {
    post: (message) => child.send(message),
    onMessage: (handler) => child.on("message", (raw) => handler(raw as WorkerToHost)),
    onExit: (handler) => child.on("exit", (code, signal) => handler(code, signal)),
    kill: () => {
      // Closing the IPC channel matters as much as the signal: the channel is a
      // live socket in *this* process, and leaving it open keeps the event loop
      // (and therefore a test run) alive long after the worker is gone.
      try {
        child.disconnect();
      } catch {
        // already disconnected
      }
      child.kill();
      child.unref();
    },
    get pid() {
      return child.pid;
    },
  };
}

function createUtilityProcess(entry: string): WorkerHandle {
  // Required lazily so this module stays importable outside Electron (tests,
  // tooling) without pulling in the electron runtime.
  const electron = requireElectron();
  // `inherit` keeps the worker's stderr (and therefore pi's stderr) visible to
  // the main process. With `pipe`, an unconsumed stream can block the worker.
  const child = electron.utilityProcess.fork(entry, [], {
    stdio: "inherit",
    serviceName: "harness-agent-worker",
  });
  return {
    post: (message) => child.postMessage(message),
    onMessage: (handler) => child.on("message", (raw: unknown) => handler(raw as WorkerToHost)),
    onExit: (handler) => child.on("exit", (code: number) => handler(code, null)),
    kill: () => child.kill(),
    get pid() {
      return child.pid;
    },
  };
}

/**
 * `electron` is CommonJS and this module is ESM, so `require` does not exist.
 * Loading it through createRequire also keeps the module importable outside
 * Electron (tests, headless tooling) without touching the electron runtime.
 */
function requireElectron(): typeof import("electron") {
  return createRequire(import.meta.url)("electron") as typeof import("electron");
}
