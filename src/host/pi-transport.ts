/**
 * Pi RPC transport.
 *
 * Owns one `pi --mode rpc` child process and speaks its JSONL protocol:
 *   stdin  <- commands (`{id?, type, ...}`) and `extension_ui_response`
 *   stdout -> `response` (command replies), session events, `extension_ui_request`
 *
 * Why not `RpcClient` from the pi package: it answers commands and re-emits
 * session events, but it has no path for `extension_ui_request`. An extension
 * asking for confirmation would block until its timeout. A desktop shell needs
 * those prompts, so the protocol is handled here.
 *
 * Framing is strict JSONL: split on LF (0x0a) only. Node's `readline` must not
 * be used -- it also splits on U+2028/U+2029, which are legal inside JSON
 * strings.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";

export type UiRequest =
  | {
      type: "extension_ui_request";
      id: string;
      method: "select";
      title: string;
      options: string[];
      timeout?: number;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "confirm";
      title: string;
      message: string;
      timeout?: number;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "input";
      title: string;
      placeholder?: string;
      timeout?: number;
    }
  | { type: "extension_ui_request"; id: string; method: "editor"; title: string; prefill?: string }
  | {
      type: "extension_ui_request";
      id: string;
      method: "notify";
      message: string;
      notifyType?: "info" | "warning" | "error";
    }
  | { type: "extension_ui_request"; id: string; method: "setStatus"; statusKey: string; statusText?: string }
  | {
      type: "extension_ui_request";
      id: string;
      method: "setWidget";
      widgetKey: string;
      widgetLines?: string[];
      widgetPlacement?: "aboveEditor" | "belowEditor";
    }
  | { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
  | { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string };

export type UiResponse =
  | { type: "extension_ui_response"; id: string; value: string }
  | { type: "extension_ui_response"; id: string; confirmed: boolean }
  | { type: "extension_ui_response"; id: string; cancelled: true };

/** Methods that block Pi until the client answers. The rest are notifications. */
const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

export type SessionEvent = { type: string; [key: string]: unknown };

export interface PiTransportOptions {
  /** Absolute path to pi's CLI bundle (dist/bundle/cli.js). */
  cliPath: string;
  /** Workspace the agent runs in. */
  cwd: string;
  /**
   * Session id owned by the host, one per session. Passed as
   * `--session-id`, so pi resumes the same transcript on every start and never
   * invents an id we do not know about.
   */
  sessionId?: string;
  /** Where pi keeps transcripts. Kept inside our data dir, not the user's ~/.pi. */
  sessionDir?: string;
  /** Human-readable name stored on the session. */
  sessionName?: string;
  provider?: string;
  model?: string;
  thinkingLevel?: string;
  extraArgs?: string[];
  env?: NodeJS.ProcessEnv;
  onEvent?: (event: SessionEvent) => void;
  /**
   * Answer a dialog request. Return `null` to cancel (Pi resolves the dialog
   * with its default). Notifications (`notify`, `setStatus`, ...) arrive here
   * too and must not be answered.
   */
  onUiRequest?: (request: UiRequest) => Promise<UiResponse | null>;
  onStderr?: (chunk: string) => void;
  /**
   * The pi process exited on its own (not because `dispose()` killed it).
   * The worker uses this to exit too: the host only recovers a session by
   * replacing its worker.
   */
  onExit?: (info: { code: number | null; signal: string | null }) => void;
}

interface Pending {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const LF = 0x0a;

export class PiTransport {
  readonly child: ChildProcessWithoutNullStreams;

  #options: PiTransportOptions;
  #pending = new Map<string, Pending>();
  #buffer: Buffer = Buffer.alloc(0);
  #seq = 0;
  #exitError: Error | null = null;
  #stderr = "";
  #disposed = false;

  constructor(options: PiTransportOptions) {
    this.#options = options;
    this.child = spawnPiProcess(options);
    this.child.stdout.on("data", (chunk: Buffer) => this.#onStdout(chunk));
    this.child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      this.#stderr += text;
      this.#options.onStderr?.(text);
    });
    this.child.on("exit", (code, signal) => {
      this.#failAll(new Error(`pi exited (code=${code}, signal=${signal})`));
      // `dispose()` kills pi on purpose, including when startup fails; only an
      // exit we did not ask for is a crash worth reporting.
      if (!this.#disposed) this.#options.onExit?.({ code, signal });
    });
    this.child.on("error", (error) => {
      this.#exitError = error;
      this.#failAll(error);
    });
  }

  static async start(options: PiTransportOptions): Promise<PiTransport> {
    const transport = new PiTransport(options);
    // A session id proves the process is past startup; an unresponsive child
    // during this window is a cold-start failure, not a slow model call.
    try {
      await transport.getState();
      return transport;
    } catch (error) {
      // pi explains itself on stderr ("No models available..."). Without that
      // line the UI can only say "exited during startup", which hides the fix.
      const tail = transport.#stderr.trim().split("\n").slice(-3).join(" | ");
      await transport.dispose().catch(() => undefined);
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(tail ? `${reason}: ${tail}` : reason);
    }
  }

  // ── public API ────────────────────────────────────────────────────────────

  get stderr(): string {
    return this.#stderr;
  }

  async request(command: Record<string, unknown>, timeoutMs = 30_000): Promise<Record<string, unknown>> {
    if (this.#exitError) throw this.#exitError;
    const id = `c${++this.#seq}`;
    const payload = { id, ...command };
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`pi command '${String(command.type)}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#write(payload);
    });
  }

  /** Send a command and return its `data` payload (responses wrap it one level). */
  async requestData<T = Record<string, unknown>>(
    command: Record<string, unknown>,
    timeoutMs = 30_000,
  ): Promise<T> {
    const response = await this.request(command, timeoutMs);
    return (response.data ?? {}) as T;
  }

  getState() {
    return this.requestData<{
      sessionId: string;
      sessionFile?: string;
      sessionName?: string;
      /** The model pi resolved for this session. */
      model?: { provider?: string; id?: string };
      thinkingLevel?: string;
      messageCount: number;
      isStreaming: boolean;
    }>({ type: "get_state" });
  }

  /** pi's RPC names the field `modelId`, not `model`; anything else is rejected. */
  setModel(provider: string, modelId: string) {
    return this.requestData<{ id?: string }>({ type: "set_model", provider, modelId });
  }

  /**
   * Full message history of the current session, including the system prompt.
   * Shape is pi's `AgentMessage`; callers narrow it themselves.
   */
  getMessages() {
    return this.requestData<{ messages: unknown[] }>({ type: "get_messages" });
  }

  /** Resolves once the prompt is accepted; events stream afterwards. */
  prompt(message: string, images?: Array<{ data: string; mimeType: string }>) {
    return this.requestData<{ disposition: string }>({
      type: "prompt",
      message,
      ...(images?.length
        ? { images: images.map((image) => ({ type: "image", data: image.data, mimeType: image.mimeType })) }
        : {}),
    });
  }

  getThinkingLevels() {
    return this.requestData<{ levels: string[] }>({ type: "get_available_thinking_levels" });
  }

  setThinkingLevel(level: string) {
    return this.request({ type: "set_thinking_level", level });
  }

  abort() {
    return this.request({ type: "abort" });
  }

  /**
   * Resolve when Pi has no more work for the current run.
   *
   * Docs say `agent_end` closes one low-level run and `agent_settled` follows
   * once retries, overflow recovery, compaction and queued follow-ups are done.
   * In practice `agent_settled` is not always emitted (pi 1.3.0), so both are
   * accepted, and an `agent_end` carrying `willRetry: true` is not treated as
   * terminal.
   */
  waitForSettled(timeoutMs = 600_000): Promise<SessionEvent[]> {
    const events: SessionEvent[] = [];
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error(`pi run did not settle within ${timeoutMs}ms`));
      }, timeoutMs);

      const unsubscribe = this.onEvent((event) => {
        events.push(event);
        const settled =
          event.type === "agent_settled" || (event.type === "agent_end" && event.willRetry !== true);
        if (!settled) return;
        clearTimeout(timer);
        unsubscribe();
        resolve(events);
      });
    });
  }

  /** Subscribe to session events. Returns an unsubscribe function. */
  onEvent(listener: (event: SessionEvent) => void): () => void {
    const wrapped = (event: SessionEvent) => listener(event);
    this.#listeners.add(wrapped);
    return () => {
      this.#listeners.delete(wrapped);
    };
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#failAll(new Error("pi transport disposed"));
    if (hasExited(this.child)) return;
    this.child.kill("SIGTERM");
    const killTimer = setTimeout(() => this.child.kill("SIGKILL"), 5_000);
    await new Promise<void>((resolve) => {
      // Re-checked here, not only above: pi can exit between the two, and
      // `once("exit")` would then never fire — which hangs the worker's
      // shutdown and leaves the process alive forever.
      if (hasExited(this.child)) return resolve();
      this.child.once("exit", () => resolve());
    });
    clearTimeout(killTimer);
  }

  // ── internals ─────────────────────────────────────────────────────────────

  #listeners = new Set<(event: SessionEvent) => void>();

  #write(payload: unknown): void {
    if (this.child.stdin.destroyed) return;
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  #onStdout(chunk: Buffer): void {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    let start = 0;
    for (;;) {
      const lf = this.#buffer.indexOf(LF, start);
      if (lf === -1) break;
      const line = this.#buffer.subarray(start, lf).toString("utf8").replace(/\r$/, "");
      start = lf + 1;
      if (line.length > 0) this.#onRecord(line);
    }
    this.#buffer = start === 0 ? this.#buffer : this.#buffer.subarray(start);
  }

  #onRecord(line: string): void {
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return; // stdout is JSONL-only; anything else is not ours to interpret
    }

    if (record.type === "response") {
      const id = typeof record.id === "string" ? record.id : "";
      const pending = this.#pending.get(id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.#pending.delete(id);
      if (record.success === false) {
        pending.reject(new Error(String(record.error ?? "pi command failed")));
      } else {
        pending.resolve(record);
      }
      return;
    }

    if (record.type === "extension_ui_request") {
      void this.#answerUi(record as unknown as UiRequest);
      return;
    }

    const event = record as SessionEvent;
    for (const listener of this.#listeners) listener(event);
    this.#options.onEvent?.(event);
  }

  async #answerUi(request: UiRequest): Promise<void> {
    if (!DIALOG_METHODS.has(request.method)) {
      // Fire-and-forget: surface it, never write a response.
      await this.#options.onUiRequest?.(request);
      return;
    }
    let response: UiResponse | null = null;
    try {
      response = (await this.#options.onUiRequest?.(request)) ?? null;
    } catch {
      response = null;
    }
    if (this.#disposed) return;
    this.#write(response ?? { type: "extension_ui_response", id: request.id, cancelled: true });
  }

  #failAll(error: Error): void {
    this.#exitError ??= error;
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      this.#pending.delete(id);
      pending.reject(this.#exitError);
    }
  }
}

function hasExited(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function spawnPiProcess(options: PiTransportOptions): ChildProcessWithoutNullStreams {
  const args = ["--mode", "rpc"];
  if (options.sessionId) args.push("--session-id", options.sessionId);
  if (options.sessionDir) args.push("--session-dir", options.sessionDir);
  if (options.sessionName) args.push("--name", options.sessionName);
  if (options.provider) args.push("--provider", options.provider);
  if (options.model) args.push("--model", options.model);
  if (options.thinkingLevel) args.push("--thinking", options.thinkingLevel);
  if (options.extraArgs) args.push(...options.extraArgs);

  // Inside Electron, `process.execPath` is the Electron binary. Without
  // ELECTRON_RUN_AS_NODE it boots Chromium (GPU + network services) instead of
  // Node, and pi dies before it can answer. Plain Node ignores the variable.
  const env: NodeJS.ProcessEnv = { ...process.env, ...options.env };
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = "1";

  const child = spawn(process.execPath, [options.cliPath, ...args], {
    cwd: options.cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  return child;
}
