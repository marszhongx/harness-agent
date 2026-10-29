/**
 * Attach pi's transcript to the session index, but only once the file exists.
 *
 * pi reports a planned path at startup; a turn can die before that path is
 * written. Every lifecycle edge (ready, settled, crashed/replaced) goes through
 * this helper so a failed first turn does not leave an index entry pointing at
 * no transcript.
 */
import { existsSync } from "node:fs";
import type { SessionStore } from "./session-store.ts";

export function attachExistingTranscript(
  store: SessionStore,
  sessionId: string,
  sessionFile: string | null | undefined,
): boolean {
  if (!sessionFile || !existsSync(sessionFile)) return false;
  store.attachFile(sessionId, sessionFile);
  return true;
}
