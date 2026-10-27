/**
 * Milestone 1 smoke test: talk to a real pi process over RPC, with no Electron
 * in the loop. Proves the transport, streaming, and extension-UI round trip.
 *
 *   node --experimental-strip-types scripts/smoke.ts
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PiTransport, type SessionEvent, type UiRequest } from "../src/host/pi-transport.ts";

const cliPath = resolve("node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
const cwd = await mkdtemp(join(tmpdir(), "harness-agent-smoke-"));

const provider = process.env.SMOKE_PROVIDER ?? "hifox";
const model = process.env.SMOKE_MODEL ?? "glm-5.3-flash";

console.log(`cli      ${cliPath}`);
console.log(`cwd      ${cwd}`);
console.log(`model    ${provider}/${model}\n`);

// An extension whose tool asks the host for confirmation. Without a real
// round trip through the transport this hangs until Pi's own dialog timeout.
// An extension whose tool asks the host for confirmation. Without a real
// round trip through the transport this hangs until Pi's own dialog timeout.
// It lives inside the project so `typebox` resolves.
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
      const ok = await ctx.ui.confirm("Approval needed", "Run the confirm probe?");
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

const events: SessionEvent[] = [];
const toolCalls: string[] = [];
const uiRequests: UiRequest[] = [];

const transport = await PiTransport.start({
  cliPath,
  cwd,
  provider,
  model,
  extraArgs: ["--extension", extFile],
  onStderr: (chunk) => process.stderr.write(`[pi] ${chunk}`),
  onEvent: (event) => {
    events.push(event);
    if (event.type === "message_update") {
      const inner = event.assistantMessageEvent as
        | { type?: string; delta?: string; toolName?: string }
        | undefined;
      if (inner?.type === "text_delta" && inner.delta) process.stdout.write(inner.delta);
      if (inner?.type === "toolcall_start" && inner.toolName) toolCalls.push(inner.toolName);
    }
  },
  onUiRequest: async (request) => {
    uiRequests.push(request);
    if (request.method === "confirm") {
      console.log(`\n[host] confirm -> "${request.title}" / "${request.message}" => approved`);
      return { type: "extension_ui_response", id: request.id, confirmed: true };
    }
    if (request.method === "notify") {
      console.log(`\n[host] notify (${request.notifyType ?? "info"}): ${request.message}`);
      return null;
    }
    return null;
  },
});

const state = (await transport.getState()) as { sessionId?: string; sessionFile?: string };
console.log(`session  ${state.sessionId}\n`);
console.log("--- assistant stream ---");

const settled = transport.waitForSettled(180_000);
await transport.prompt(
  "Call the confirm_probe tool once, then reply with exactly the sentence: SMOKE_OK plus the tool's answer.",
);
await settled;

console.log("\n--- result ---");
console.log("tool calls:", toolCalls.length > 0 ? toolCalls.join(", ") : "(none)");
console.log("ui requests:", uiRequests.map((r) => r.method).join(", ") || "(none)");
console.log("event types:", [...new Set(events.map((e) => e.type))].join(", "));

const confirmed = uiRequests.some((r) => r.method === "confirm");
const usedTool = toolCalls.includes("confirm_probe");

await transport.dispose();

if (!confirmed) {
  console.error("\nFAIL: the confirm dialog never reached the host");
  process.exit(1);
}
if (!usedTool) {
  console.error("\nFAIL: the agent never called confirm_probe");
  process.exit(1);
}
console.log("\nPASS: transport + streaming + extension-UI round trip");
