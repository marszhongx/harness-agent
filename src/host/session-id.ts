/**
 * Session identity, and the one-way transform onto pi's namespace.
 *
 * A session inside the app is a plain UUIDv4: our handle, nothing else.
 * pi never sees that spelling — it is handed `<prefix>-<uuid>`, because its
 * session directory is a shared namespace and the prefix says which product
 * owns the transcript.
 *
 * The transform only runs in this direction. There is no reverse function,
 * because nothing is ever read back out of pi's files: the session index is
 * ours (see `session-store.ts`).
 */
import { randomUUID } from "node:crypto";

/** Interior id for a new session: a full UUIDv4, 122 bits of entropy. */
export function mintSessionId(): string {
  return randomUUID();
}

/** The spelling pi stores on disk and looks up by. */
export function toPiSessionId(sessionId: string, prefix: string): string {
  const brand = sanitizePrefix(prefix);
  return brand ? `${brand}-${sessionId}` : sessionId;
}

/**
 * pi validates ids against `^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$`
 * and the id becomes part of a file name, so the brand is folded to `[a-z0-9-]`
 * and trimmed. Returns "" for a brand with nothing usable in it.
 */
function sanitizePrefix(prefix: string): string {
  return prefix
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
