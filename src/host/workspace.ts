/**
 * A session's working directory.
 *
 * pi is spawned with `cwd = <session workspace>`, so the directory decides which
 * files the agent can touch. Two different rules apply:
 *
 *   - the app's own default directory is created on demand (nobody picked it);
 *   - a directory somebody picked is taken as written: if it is gone, the turn
 *     fails with a clear message instead of silently working somewhere else.
 */
import { existsSync, mkdirSync, statSync } from "node:fs";

/** The app's own workspace: created if missing, because we chose it. */
export function ensureDefaultWorkspace(path: () => string): string {
  const target = path();
  try {
    if (!existsSync(target)) mkdirSync(target, { recursive: true });
  } catch {
    // The spawn will report the failure; there is no better directory to use.
  }
  return target;
}

/**
 * A workspace that has to exist already. Returns the reason when it does not,
 * so the caller can refuse the turn before a worker is spawned.
 */
export function checkWorkspace(path: string): string | null {
  try {
    if (!statSync(path).isDirectory()) return `工作目录不是文件夹：${path}`;
    return null;
  } catch {
    return `工作目录不存在：${path}`;
  }
}
