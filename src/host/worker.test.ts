/**
 * The worker's own lifecycle, with a fake pi instead of the real CLI.
 *
 * The host recovers a session by replacing its worker, so the worker has to
 * exit when pi dies. Staying alive with no transport looks healthy from the
 * outside (the pid is there) while every later prompt is answered with
 * "a run is already in flight".
 */
import { type ChildProcess, fork } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const workerEntry = fileURLToPath(new URL("./worker.ts", import.meta.url));

/** Just enough of the RPC protocol to get the worker ready, then die mid-turn. */
const FAKE_PI = `
let buffer = "";
process.stdin.setEncoding("utf8");
const reply = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.type === "get_state") {
      reply({
        type: "response",
        id: message.id,
        success: true,
        data: {
          sessionId: "fake-session",
          sessionFile: null,
          model: { provider: "fake", id: "fake" },
          thinkingLevel: "low",
          messageCount: 0,
          isStreaming: false,
        },
      });
    } else if (message.type === "get_available_thinking_levels") {
      reply({ type: "response", id: message.id, success: true, data: { levels: [] } });
    } else if (message.type === "prompt") {
      // A crash between accepting the prompt and finishing the run: no
      // agent_end, no agent_settled.
      process.exit(1);
    } else {
      reply({ type: "response", id: message.id, success: true, data: {} });
    }
  }
});
`;

const workers: ChildProcess[] = [];

afterEach(() => {
  for (const worker of workers.splice(0)) {
    if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL");
  }
});

async function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T | "timeout"> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe("worker", () => {
  it("exits when pi dies, so the host can replace it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "harness-worker-"));
    const piCliPath = join(dir, "fake-pi.mjs");
    await writeFile(piCliPath, FAKE_PI, "utf8");

    const worker = fork(workerEntry, [], {
      execArgv: ["--experimental-strip-types", "--no-warnings"],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    workers.push(worker);

    const errors: string[] = [];
    const ready = new Promise<void>((resolve) => {
      worker.on("message", (message: { type?: string; fatal?: boolean; message?: string }) => {
        if (message?.type === "ready") resolve();
        if (message?.type === "error" && message.fatal) errors.push(message.message ?? "");
      });
    });
    const exited = new Promise<number | null>((resolve) => {
      worker.once("exit", (code) => resolve(code));
    });

    worker.send({
      type: "init",
      cliPath: piCliPath,
      cwd: dir,
      sessionId: "fake-session",
      sessionDir: join(dir, "sessions"),
    });
    expect(await within(ready, 5_000)).not.toBe("timeout");

    worker.send({ type: "prompt", requestId: "r1", message: "hello" });

    const code = await within(exited, 5_000);
    expect(code).not.toBe("timeout");
    expect(code).not.toBe(0);
    expect(errors.some((text) => text.includes("pi exited"))).toBe(true);
  });
});
