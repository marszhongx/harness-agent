import { existsSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { initLogger, logFilePath, logger, rollDaily } from "./logger.ts";

let dir: string;

const file = () => join(dir, "application.log");
const read = () => readFileSync(file(), "utf8");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "logger-"));
});

describe("logger", () => {
  it("writes aligned time, level, tag, message and key=value pairs", () => {
    const path = initLogger(dir, { tag: "main" });
    logger.info("started", { version: "1.0.0", attempt: 2 });
    logger.warn("slow");

    expect(path).toBe(file());
    expect(logFilePath()).toBe(file());
    const [first, second] = read().trim().split("\n");
    expect(first).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} {2}info +main +started +version=1\.0\.0 attempt=2$/,
    );
    // The timestamp is local time, matching the daily file name.
    const now = new Date();
    const pad = (value: number) => String(value).padStart(2, "0");
    expect(first.startsWith(`${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`)).toBe(
      true,
    );
    // A line without meta carries no trailing padding.
    expect(second).toMatch(/warn +main +slow$/);
  });

  it("quotes values with spaces and shortens session ids", () => {
    initLogger(dir);
    logger.warn("pi stderr", "No project session found");
    logger.info("prompt", { sessionId: "cab8d009-3161-47d1-8923-a0269b06bb49", chars: 9 });

    expect(read()).toContain('pi stderr         "No project session found"');
    // A multi-line value is escaped so one entry cannot span several lines.
    logger.info("stack", { stack: "Error: x\n    at y" });
    expect(read()).toContain('stack="Error: x\\n    at y"');
    expect(read()).toContain("sessionId=cab8d009 chars=9");

    // pi's ids carry our brand; the uuid still has to survive the shortening.
    logger.info("pi ready", { piSessionId: "harness-agent-8ee8575e-0622-4d4b-88a6-05cbe3f04fbf" });
    expect(read()).toContain("piSessionId=8ee8575e");
  });

  it("records the stack of an Error on the following lines", () => {
    initLogger(dir);
    logger.error("boom", new Error("bad thing"));

    expect(read()).toContain('boom              error="Error: bad thing"');
    expect(read()).toContain("    at ");
    expect(read()).toContain("logger.test.ts");
  });

  it("drops entries below the configured level", () => {
    initLogger(dir, { level: "warn" });
    logger.debug("noise");
    logger.info("also noise");
    logger.warn("kept");

    expect(read()).not.toContain("noise");
    expect(read()).toContain("kept");
  });

  it("moves yesterday's file aside and keeps the last seven days", () => {
    const day = (offset: number) => {
      const date = new Date(2026, 9, 27, 12, 0, 0);
      date.setDate(date.getDate() - offset);
      const pad = (n: number) => String(n).padStart(2, "0");
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    };

    // Yesterday's lines, still sitting in the active file.
    writeFileSync(join(dir, "application.log"), "old line\n");
    const yesterday = new Date(2026, 9, 26, 12, 0, 0);
    utimesSync(join(dir, "application.log"), yesterday, yesterday);
    for (let index = 0; index < 9; index += 1) {
      writeFileSync(join(dir, `application-${day(index + 2)}.log`), "x\n");
    }

    rollDaily(dir, new Date(2026, 9, 27, 12, 0, 0), 7);

    expect(existsSync(join(dir, "application.log"))).toBe(false);
    expect(existsSync(join(dir, "application-2026-10-26.log"))).toBe(true);
    // Nine old files plus the one just rolled: only seven days survive.
    const kept = readdirSync(dir).filter((name) => /^application-\d{4}-\d{2}-\d{2}\.log$/.test(name));
    expect(kept).toHaveLength(7);
    expect(kept.some((name) => name.includes("2026-10-26"))).toBe(true);
  });

  it("leaves today's file alone", () => {
    const now = new Date(2026, 9, 27, 12, 0, 0);
    writeFileSync(join(dir, "application.log"), "today\n");
    // The file's mtime is what decides its day, so pin it to `now`.
    utimesSync(join(dir, "application.log"), now, now);

    rollDaily(dir, now, 7);

    expect(readFileSync(join(dir, "application.log"), "utf8")).toBe("today\n");
  });

  it("writes nothing before init", () => {
    logger.info("ignored");

    expect(readdirSync(dir)).toEqual([]);
  });

  it("creates its directory and survives an unusable path", () => {
    initLogger(join(dir, "nested", "deep"));
    logger.info("creates its directory");
    expect(existsSync(join(dir, "nested", "deep", "application.log"))).toBe(true);

    const blocked = join(dir, "blocked");
    writeFileSync(blocked, "not a directory");
    initLogger(join(blocked, "logs"));
    expect(() => logger.info("still fine")).not.toThrow();
  });
});
