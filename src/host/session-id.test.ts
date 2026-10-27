import { describe, expect, it } from "vitest";
import { mintSessionId, toPiSessionId } from "./session-id.ts";

describe("mintSessionId", () => {
  it("is a bare UUIDv4", () => {
    expect(mintSessionId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it("never repeats", () => {
    const ids = new Set(Array.from({ length: 500 }, () => mintSessionId()));
    expect(ids.size).toBe(500);
  });
});

describe("toPiSessionId", () => {
  const id = "6f1c0000-0000-4000-8000-000000000000";

  it("prefixes the brand", () => {
    expect(toPiSessionId(id, "harness-agent")).toBe(`harness-agent-${id}`);
  });

  it("folds anything unusable in a brand into dashes", () => {
    expect(toPiSessionId(id, "Harness Agent! ")).toBe(`harness-agent-${id}`);
  });

  it("omits the dash when there is no brand", () => {
    expect(toPiSessionId(id, "")).toBe(id);
    expect(toPiSessionId(id, "---")).toBe(id);
  });

  it("produces an id pi accepts (alphanumeric at both ends)", () => {
    const piId = toPiSessionId(id, "harness-agent");
    expect(piId.startsWith("h")).toBe(true);
    expect(piId.endsWith("0")).toBe(true);
    expect(/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(piId)).toBe(true);
  });
});
