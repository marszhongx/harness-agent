/**
 * Milestone 2 smoke test: the real three-process shape, minus Electron.
 *
 *   main (this script)  <-- IPC -->  worker  <-- JSONL -->  pi  -->  model
 *
 * Verifies: worker startup, prompt streaming, dialog round trip through the
 * host, and crash recovery when the worker is killed.
 *
 *   node --experimental-strip-types scripts/smoke-host.ts
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AgentHost } from "../src/host/agent-host.ts";
import type { DialogRequest, UiAnswer, WorkerToHost } from "../src/host/protocol.ts";

const piCliPath = resolve("node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
const workerEntry = resolve("src/host/worker.ts");
const root = await mkdtemp(join(tmpdir(), "harness-agent-host-"));
const cwd = join(root, "workspace");
const sessionDir = join(root, "sessions");
await mkdir(cwd, { recursive: true });
await mkdir(sessionDir, { recursive: true });

const provider = process.env.SMOKE_PROVIDER ?? "hifox";
const model = process.env.SMOKE_MODEL ?? "glm-5.3-flash";

// Extension whose tool needs a human decision.
// Generated fixture: inside the project so `typebox` resolves, but under
// scripts/ so it never looks like product code.
const extDir = resolve("scripts/.fixtures");
const extFile = join(extDir, "confirm-ext.ts");
await mkdir(extDir, { recursive: true });
await writeFile(
  extFile,
  `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "confirm_probe",
    description: "Ask the operator to confirm something, then report their answer.",
    parameters: Type.Object({}),
    execute: async (_id, _params, _signal, _onUpdate, ctx) => {
      const ok = await ctx.ui.confirm("Deploy?", "Ship the change to production?");
      return {
        content: [{ type: "text", text: ok ? "operator approved" : "operator declined" }],
        details: undefined,
      };
    },
  });
}
`,
  "utf8",
);

const events: WorkerToHost[] = [];
const dialogs: DialogRequest[] = [];
let answered = 0;
let settledResolve: (() => void) | null = null;
let firstSettled = new Promise<void>((r) => {
  settledResolve = r;
});

const host = await AgentHost.start({
  workerEntry,
  piCliPath,
  cwd,
  sessionDir,
  sessionIdPrefix: "harness",
  provider,
  model,
  extraArgs: ["--extension", extFile],
  // The host passes (requestId, dialog); the id only matters when the answer is
  // written back asynchronously, which this test does not need.
  askUser: (_requestId, dialog) => {
    dialogs.push(dialog);
    answered += 1;
    const answer: UiAnswer =
      dialog.method === "confirm"
        ? { kind: "confirm", confirmed: true }
        : dialog.method === "select"
          ? { kind: "value", value: dialog.options[0] ?? "" }
          : { kind: "cancel" };
    return answer;
  },
  onRestart: (info) => console.log(`\n[host] worker restart #${info.attempt} (code=${info.code})`),
  onEvent: (message) => {
    events.push(message);
    switch (message.type) {
      case "text_delta":
        process.stdout.write(message.delta);
        break;
      case "tool_start":
        console.log(`\n[host] tool start: ${message.toolName}`);
        break;
      case "tool_end":
        console.log(`[host] tool end: ${message.toolName} error=${message.isError ?? false}`);
        break;
      case "ui_request":
        console.log(`\n[host] dialog -> ${message.request.method}: ${message.request.title}`);
        break;
      case "notify":
        console.log(`\n[host] notify(${message.level}): ${message.message}`);
        break;
      case "error":
        console.error(`\n[host] error: ${message.message}`);
        break;
      case "settled":
        settledResolve?.();
        break;
      default:
        break;
    }
  },
});

console.log(`worker pid ${host.workerPid}`);
console.log(`session    ${host.sessionId}`);
console.log(`model      ${provider}/${model}`);
console.log("--- stream ---");

await host.prompt("Call confirm_probe once, then reply with the tool's answer and nothing else.");
await firstSettled;

const text = events
  .filter((e): e is Extract<WorkerToHost, { type: "text_delta" }> => e.type === "text_delta")
  .map((e) => e.delta)
  .join("");
const tools = events
  .filter((e): e is Extract<WorkerToHost, { type: "tool_start" }> => e.type === "tool_start")
  .map((e) => e.toolName);

console.log("\n\n--- result ---");
console.log("text      ", JSON.stringify(text.trim().slice(0, 120)));
console.log("tools     ", [...new Set(tools)].join(", ") || "(none)");
console.log("dialogs   ", dialogs.map((d) => d.method).join(", ") || "(none)", `answered=${answered}`);
console.log("event set ", [...new Set(events.map((e) => e.type))].join(", "));

if (!dialogs.some((d) => d.method === "confirm")) {
  console.error("\nFAIL: dialog never reached the host");
  await host.dispose();
  process.exit(1);
}
if (!tools.includes("confirm_probe")) {
  console.error("\nFAIL: confirm_probe was never called");
  await host.dispose();
  process.exit(1);
}
if (!text.toLowerCase().includes("operator approved")) {
  console.error("\nFAIL: the tool result never made it back into the reply");
  await host.dispose();
  process.exit(1);
}

// ── abort is per conversation ───────────────────────────────────────────────
//
// Every conversation owns its worker, so interrupting one must leave the other
// running. The victim gets a long answer to interrupt; the witness gets a slow
// tool call, which keeps it busy well past the abort.
const startHost = (onEvent: (message: WorkerToHost) => void) =>
  AgentHost.start({
    workerEntry,
    piCliPath,
    cwd,
    sessionDir,
    sessionIdPrefix: "harness",
    provider,
    model,
    extraArgs: ["--extension", extFile],
    askUser: () => ({ kind: "cancel" }),
    onRestart: () => undefined,
    onEvent,
  });

let victimSettled = false;
let witnessSettled = false;
const witnessEvents: WorkerToHost[] = [];
const victim = await startHost((message) => {
  if (message.type === "settled") victimSettled = true;
});
const witness = await startHost((message) => {
  witnessEvents.push(message);
  if (message.type === "settled") witnessSettled = true;
});

if (victim.workerPid === witness.workerPid) {
  console.error("FAIL: the two conversations share a worker");
  process.exit(1);
}
console.log(`\n[host] two sessions on two workers: ${victim.workerPid} and ${witness.workerPid}`);

await witness.prompt("Use the bash tool to run `sleep 6`, then reply with exactly: B_DONE");
await victim.prompt("Write a 40 line poem about autumn. Output the poem only.");
await new Promise((r) => setTimeout(r, 2500));

victimSettled = false;
victim.abort();

const abortDeadline = Date.now() + 20_000;
while (!victimSettled && Date.now() < abortDeadline) {
  await new Promise((r) => setTimeout(r, 200));
}
const witnessWasRunning = !witnessSettled;
const witnessFinishedEarly = witnessEvents.some((e) => e.type === "text_delta" && e.delta.includes("B_DONE"));
console.log(
  `[host] interrupted ${victim.workerPid} (settled=${victimSettled}); ${witness.workerPid} still running=${witnessWasRunning}`,
);

const witnessDeadline = Date.now() + 90_000;
while (!witnessSettled && Date.now() < witnessDeadline) {
  await new Promise((r) => setTimeout(r, 250));
}
const witnessText = witnessEvents
  .filter((e): e is Extract<WorkerToHost, { type: "text_delta" }> => e.type === "text_delta")
  .map((e) => e.delta)
  .join("");
await Promise.all([victim.dispose(), witness.dispose()]);

if (!victimSettled) {
  console.error("FAIL: abort did not settle the interrupted conversation");
  process.exit(1);
}
if (!witnessWasRunning || witnessFinishedEarly) {
  console.error("FAIL: aborting one conversation also stopped the other");
  process.exit(1);
}
if (!witnessText.includes("B_DONE")) {
  console.error("FAIL: the witness conversation never finished its own turn");
  process.exit(1);
}
console.log("[host] the other conversation kept running and finished on its own");

// ── crash recovery ──────────────────────────────────────────────────────────
const pidBefore = host.workerPid;
if (!pidBefore) throw new Error("worker has no pid");
process.kill(pidBefore, "SIGKILL");
console.log(`\n[host] killed worker ${pidBefore}; waiting for automatic recovery...`);

firstSettled = new Promise<void>((r) => {
  settledResolve = r;
});
const deadline = Date.now() + 60_000;
while (!host.workerPid || host.workerPid === pidBefore) {
  if (Date.now() > deadline) {
    console.error("FAIL: worker was not respawned");
    await host.dispose();
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 250));
}
console.log(`[host] worker respawned as ${host.workerPid}, session ${host.sessionId}`);

await host.prompt("Reply with exactly: RECOVERED");
await firstSettled;
const recoveredText = events
  .filter((e): e is Extract<WorkerToHost, { type: "text_delta" }> => e.type === "text_delta")
  .slice(-20)
  .map((e) => e.delta)
  .join("");
console.log("recovered reply:", JSON.stringify(recoveredText.trim().slice(-60)));

await host.dispose();

if (!recoveredText.toUpperCase().includes("RECOVERED")) {
  console.error("\nFAIL: the recovered worker never answered");
  process.exit(1);
}
console.log("\nPASS: three-process shape + dialogs + per-session abort + crash recovery");
