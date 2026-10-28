/**
 * AgentHost lifecycle, with a stub worker instead of pi.
 *
 * The stub speaks just enough of the protocol to prove the host's own promises:
 * startup, event routing, and — the reason this file exists — that a stop that
 * pi ignores ends with the worker being replaced, while a stop pi honours leaves
 * the process alone.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentHost, type AgentHostOptions } from "./agent-host.ts";
import type { WorkerToHost } from "./protocol.ts";

const STUB = `
const mode = process.env.STUB_MODE ?? "fast";
let promptTimer = null;

function reply(message) {
  process.send?.(message);
}

process.on("message", (message) => {
  switch (message.type) {
    case "init":
      reply({
        type: "ready",
        piSessionId: message.sessionId,
        sessionFile: null,
        provider: "stub",
        model: "stub-model",
      });
      return;
    case "prompt":
      if (mode === "fast") {
        reply({ type: "text_delta", delta: "ok" });
        reply({ type: "settled" });
      } else if (mode === "slow") {
        promptTimer = setTimeout(() => reply({ type: "settled" }), 10_000);
      }
      return;
    case "abort":
      if (mode === "fast" || mode === "slow") {
        clearTimeout(promptTimer);
        reply({ type: "settled" });
      }
      // "hang" never answers, which is what a wedged pi looks like.
      return;
    case "shutdown":
      process.exit(0);
      return;
    default:
      return;
  }
});
`;

let dir: string;
let workerEntry: string;
const hosts: AgentHost[] = [];

const startHost = async (mode: "fast" | "slow" | "hang", overrides: Partial<AgentHostOptions> = {}) => {
  process.env.STUB_MODE = mode;
  const events: WorkerToHost[] = [];
  const ends: Array<{ reason: "replaced" | "crashed" }> = [];
  const host = await AgentHost.start({
    workerEntry,
    piCliPath: "unused",
    cwd: dir,
    sessionDir: join(dir, "sessions"),
    abortGraceMs: 250,
    onEvent: (message) => events.push(message),
    onTurnEnd: (info) => ends.push(info),
    ...overrides,
  });
  hosts.push(host);
  return { host, events, ends };
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) await sleep(25);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agent-host-"));
  workerEntry = join(dir, "stub-worker.mjs");
  await writeFile(workerEntry, STUB, "utf8");
});

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.dispose()));
});

describe("AgentHost", () => {
  it("reports the session id pi opened", async () => {
    const { host } = await startHost("fast");
    expect(host.piSessionId).toBe(host.sessionId);
    expect(host.workerPid).toBeGreaterThan(0);
  });

  it("ends the turn when the worker settles", async () => {
    const { host, events } = await startHost("fast");
    await host.prompt("hi");
    await sleep(150);

    expect(events.map((event) => event.type)).toContain("settled");
    const pid = host.workerPid;
    host.abort();
    await sleep(400);
    // Nothing was running, so nothing was restarted.
    expect(host.workerPid).toBe(pid);
  });

  it("keeps the worker when pi honours the abort", async () => {
    const { host } = await startHost("slow");
    await host.prompt("long task");
    const pid = host.workerPid;

    host.abort();
    await sleep(400);

    expect(host.workerPid).toBe(pid);
  });

  it("replaces the worker when the abort is ignored", async () => {
    const { host, events, ends } = await startHost("hang");
    await host.prompt("long task");
    const pid = host.workerPid;

    host.abort();
    await sleep(900);

    expect(host.workerPid).not.toBe(pid);
    expect(events.some((event) => event.type === "notify")).toBe(true);
    // The worker that ignored the abort took the turn with it; the caller has
    // to be told, because no `settled` will ever arrive.
    expect(ends).toEqual([{ reason: "replaced" }]);
  });

  it("reports a turn that dies with a crashed worker", async () => {
    const { host, ends } = await startHost("hang");
    await host.prompt("long task");
    const pid = host.workerPid;
    if (!pid) throw new Error("worker has no pid");

    process.kill(pid, "SIGKILL");
    await waitFor(() => ends.length > 0);

    expect(ends).toEqual([{ reason: "crashed" }]);
  });

  it("restarts only its own worker", async () => {
    const first = await startHost("hang");
    const second = await startHost("slow");
    await first.host.prompt("long task");
    await second.host.prompt("long task");
    const firstPid = first.host.workerPid;
    const secondPid = second.host.workerPid;

    first.host.abort();
    await sleep(900);

    expect(first.host.workerPid).not.toBe(firstPid);
    expect(second.host.workerPid).toBe(secondPid);
  });
});
