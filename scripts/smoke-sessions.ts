/**
 * Session ownership check.
 *
 * The host mints one id per session and passes it to pi as `--session-id`.
 * Ownership has to mean three things:
 *
 *   1. pi opens exactly the id we asked for, not one of its own
 *   2. transcripts live in our session dir, not the user's ~/.pi
 *   3. reopening the same id later resumes the same transcript
 *
 *   node --experimental-strip-types --no-warnings scripts/smoke-sessions.ts
 */
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AgentHost } from "../src/host/agent-host.ts";
import type { WorkerToHost } from "../src/host/protocol.ts";
import { mintSessionId } from "../src/host/session-id.ts";

const piCliPath = resolve("node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
const workerEntry = resolve("src/host/worker.ts");
const root = await mkdtemp(join(tmpdir(), "harness-agent-sessions-"));
const cwd = join(root, "workspace");
const sessionDir = join(root, "sessions");
// Both must exist: spawn() fails with ENOENT when its cwd is missing, and pi
// will not create the transcript directory either.
await mkdir(cwd, { recursive: true });
await mkdir(sessionDir, { recursive: true });

const provider = process.env.SMOKE_PROVIDER ?? "hifox";
const model = process.env.SMOKE_MODEL ?? "glm-5.3-flash";

/** Events from whichever host is currently active. */
let sink: WorkerToHost[] = [];
const collect = (message: WorkerToHost) => sink.push(message);

const baseOptions = {
  workerEntry,
  piCliPath,
  cwd,
  sessionDir,
  // The brand is applied at the pi boundary only; this is the transform under
  // test, so the assertion below expects the branded spelling.
  sessionIdPrefix: "harness",
  provider,
  model,
  onEvent: collect,
  askUser: () => ({ kind: "cancel" as const }),
};

/** Every host this script opens, so a failed assertion cannot leave a pi behind. */
const openHosts: AgentHost[] = [];
function track(host: AgentHost): AgentHost {
  openHosts.push(host);
  return host;
}

async function shutdownAll(): Promise<void> {
  for (const host of openHosts) await host.dispose().catch(() => undefined);
  openHosts.length = 0;
}

/** Send one prompt and resolve with the streamed assistant text. */
async function turn(host: AgentHost, prompt: string): Promise<string> {
  sink = [];
  let resolveSettled: (() => void) | null = null;
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });
  const poll = setInterval(() => {
    if (sink.some((m) => m.type === "settled")) resolveSettled?.();
  }, 100);
  // Cleared, not raced and abandoned: an uncleared 120s timer keeps node alive
  // long after the script has printed its verdict.
  const guard = setTimeout(() => resolveSettled?.(), 120_000);
  await host.prompt(prompt);
  await settled;
  clearInterval(poll);
  clearTimeout(guard);
  return sink
    .filter((m): m is Extract<WorkerToHost, { type: "text_delta" }> => m.type === "text_delta")
    .map((m) => m.delta)
    .join("");
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

for (const signal of ["uncaughtException", "unhandledRejection"] as const) {
  process.on(signal, (error) => {
    console.error(error);
    void shutdownAll().finally(() => process.exit(1));
  });
}

// ── session A ───────────────────────────────────────────────────────────────
const host = track(await AgentHost.start(baseOptions));
const firstId = host.sessionId;
console.log(`session          ${firstId}`);
console.log(`pi sessionId     ${host.piSessionId}`);
console.log(`sessionFile      ${host.sessionFile}`);

assert(
  host.piSessionId === `harness-${firstId}`,
  `pi opened ${host.piSessionId}, expected harness-${firstId}`,
);
assert(
  typeof host.sessionFile === "string" && host.sessionFile.startsWith(sessionDir),
  `transcript is not inside our session dir (${sessionDir})`,
);

const firstFile = host.sessionFile;
console.log(
  `turn 1           ${JSON.stringify((await turn(host, "Reply with exactly: SESSION_ONE")).trim())}`,
);

// ── session B: a different id, never a reused one ───────────────────────────
const secondId = await host.switchSession(mintSessionId());
console.log(`new session      ${secondId}`);
assert(secondId !== firstId, "new session reused the old id");
assert(
  host.piSessionId === `harness-${secondId}`,
  `pi opened ${host.piSessionId}, expected harness-${secondId}`,
);
assert(
  (await turn(host, "Reply with exactly: SESSION_TWO")).toUpperCase().includes("SESSION_TWO"),
  "second session did not answer",
);

await shutdownAll();

// ── reopen session A in a fresh host ────────────────────────────────────────
// A new process must land on the same transcript, which only happens when the
// id is ours: pi has nothing else to go on.
const resumed = track(await AgentHost.start({ ...baseOptions, sessionId: firstId }));
console.log(`resumed id       ${resumed.sessionId}`);
console.log(`resumed file     ${resumed.sessionFile}`);
assert(resumed.piSessionId === `harness-${firstId}`, `resumed host opened ${resumed.piSessionId}`);
assert(
  resumed.sessionFile === firstFile,
  `resumed host opened ${resumed.sessionFile}, expected ${firstFile}`,
);

await shutdownAll();
console.log("\nPASS: host-owned session ids + resumable transcripts");
process.exit(0);
