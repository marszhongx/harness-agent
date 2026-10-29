/**
 * The channel map is the contract between two processes that cannot import each
 * other's code; a duplicate or a mismatched prefix would only fail at runtime.
 */
import { describe, expect, it } from "vitest";
import { IpcAction } from "./ipc-action.ts";

describe("IpcAction", () => {
  it("keeps every channel unique", () => {
    const values = Object.values(IpcAction).flatMap((group) => Object.values(group));

    expect(new Set(values).size).toBe(values.length);
  });

  it("keeps each channel under its group's prefix", () => {
    for (const [group, entries] of Object.entries(IpcAction)) {
      for (const value of Object.values(entries)) {
        expect(value.startsWith(`${group}:`)).toBe(true);
      }
    }
  });
});
