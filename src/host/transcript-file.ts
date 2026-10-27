/**
 * Read a conversation's transcript without pi.
 *
 * pi stores each session as append-only JSONL (`docs/session-format.md`): one
 * JSON object per line, the first line a header, every other line an entry that
 * links to its parent by id. Two consequences shape this reader:
 *
 *  - the file is a *tree*, not a list. Rewinding and continuing leaves the
 *    abandoned branch in the file, so the visible conversation is the chain from
 *    the newest entry back through `parentId`, not "every line in order".
 *  - the last line can be a torn write. A line that does not parse is skipped
 *    rather than failing the whole read.
 *
 * Only `message` entries contribute: model changes, thinking levels, usage and
 * compaction summaries are bookkeeping that `toTranscript` would discard anyway.
 */
import { readFileSync } from "node:fs";
import type { TranscriptItem } from "./protocol.ts";
import { toTranscript } from "./transcript.ts";

interface Entry {
  type?: string;
  id?: string;
  parentId?: string | null;
  message?: unknown;
}

export function readTranscript(filePath: string): TranscriptItem[] {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch {
    return [];
  }

  const entries: Entry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Entry;
      if (parsed && typeof parsed === "object") entries.push(parsed);
    } catch {
      // Torn tail from a crash mid-write; the rest of the file is still good.
    }
  }

  const active = activeBranch(entries);
  const messages = entries
    .filter((entry) => entry.type === "message" && entry.id !== undefined && active.has(entry.id))
    .map((entry) => entry.message);

  return toTranscript(messages);
}

/** Entry ids from the newest entry back to the root, following `parentId`. */
function activeBranch(entries: Entry[]): Set<string> {
  const byId = new Map<string, Entry>();
  for (const entry of entries) {
    if (entry.id) byId.set(entry.id, entry);
  }

  // The file is append-only, so the last entry that has an id is the leaf of the
  // branch the user is currently on.
  let leaf: Entry | undefined;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index].id) {
      leaf = entries[index];
      break;
    }
  }
  if (!leaf?.id) return new Set();

  const chain = new Set<string>();
  let cursor: Entry | undefined = leaf;
  while (cursor?.id && !chain.has(cursor.id)) {
    chain.add(cursor.id);
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }
  return chain;
}
