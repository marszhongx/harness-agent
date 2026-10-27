/**
 * Resume check: a session id we mint must reopen the same transcript.
 *
 *   1. spawn pi with id A, run one turn, dispose
 *   2. spawn pi with the same id A, read `get_messages` back
 *
 * Step 2 is what the session list depends on: switching to a past session
 * has to render its history, not an empty window.
 */
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readDefaultModel } from "../src/host/pi-settings.ts";
import { PiTransport } from "../src/host/pi-transport.ts";
import { mintSessionId, toPiSessionId } from "../src/host/session-id.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = resolve(repoRoot, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");

const cwd = mkdtempSync(join(tmpdir(), "harness-agent-resume-"));
const sessionDir = join(cwd, "sessions");

// Talk to whatever this machine has configured; no test-only override.
const target = readDefaultModel();
const sessionId = toPiSessionId(mintSessionId(), "harness");

const base = {
  cliPath,
  cwd,
  sessionDir,
  provider: target?.provider,
  model: target?.id,
  sessionName: "resume probe",
  onStderr: (chunk: string) => process.stderr.write(`[pi] ${chunk}`),
};

const first = await PiTransport.start({ ...base, sessionId });
await first.prompt("回复：RESUME_ONE");
await first.waitForSettled(120_000);
const before = await first.requestData<{ messages: unknown[] }>({ type: "get_messages" });
await first.dispose();

const second = await PiTransport.start({ ...base, sessionId });
const after = await second.requestData<{ messages: unknown[] }>({ type: "get_messages" });

// A resumed session must still accept turns, not just replay them.
await second.prompt("回复：RESUME_TWO");
await second.waitForSettled(180_000);
const grown = await second.requestData<{ messages: unknown[] }>({ type: "get_messages" });
const state = await second.getState();
await second.dispose();

console.log(`session        ${sessionId}`);
console.log(`files          ${readdirSync(sessionDir).length}`);
console.log(
  `messages before ${before.messages.length}  after ${after.messages.length}  grown ${grown.messages.length}`,
);
console.log(`sessionFile    ${state.sessionFile}`);
console.log(`messageCount   ${state.messageCount}`);
console.log("--- message shapes ---");
for (const message of after.messages) {
  const record = message as {
    role?: string;
    content?: unknown;
    toolCallId?: string;
    toolName?: string;
    isError?: boolean;
  };
  const content = Array.isArray(record.content)
    ? record.content
        .map((part) => {
          const piece = part as { type?: string; text?: string; name?: string };
          return `${piece.type}${piece.text ? `=${String(piece.text).slice(0, 40)}` : ""}${piece.name ? `=${piece.name}` : ""}`;
        })
        .join(", ")
    : `str=${String(record.content).slice(0, 40)}`;
  console.log(`  ${record.role}${record.toolName ? `(${record.toolName})` : ""}: [${content}]`);
}

const resumed = after.messages.length >= before.messages.length && after.messages.length > 0;
const appended = grown.messages.length > after.messages.length;
console.log(resumed ? "PASS: id resumes the transcript" : "FAIL: transcript did not come back");
console.log(
  appended ? "PASS: resumed session accepts a new turn" : "FAIL: prompt after resume added nothing",
);
process.exit(resumed && appended ? 0 : 1);
