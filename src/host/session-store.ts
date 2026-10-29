/**
 * Our session index: one JSON file, the shape OpenClaw uses for its
 * `sessions.json` — the list of sessions plus the id of the current one.
 *
 * A session is ours: we mint its id, own its title and recency. pi only gets
 * asked to keep the transcript, under the branded spelling of that id (see
 * `session-id.ts`). The relationship is one-way and recorded here:
 *
 *   { id: "6f1c…", sessionFile: "2026-10-22T10-29-45-942Z_harness-agent-6f1c….jsonl" }
 *
 * `sessionFile` is filled from what pi reports on startup, not by parsing its
 * naming scheme — so this file stays valid if pi ever renames its transcripts.
 *
 * Why a file and not a database: the index is a handful of small fields per
 * session and it belongs next to the transcripts it points at, where a human can
 * read it and a backup can carry both. Updates are written to a temporary file
 * and renamed into place, so a crash mid-write leaves the previous index intact
 * rather than a truncated one.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";

export interface SessionEntry {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** Transcript file name inside pi's session directory, once pi has opened it. */
  sessionFile?: string;
  /** Model this session last ran on; handed back to pi when the session is reopened. */
  model?: { provider: string; id: string };
  /** Thinking level the user last chose for this session. */
  thinkingLevel?: string;
  /** Working directory the session was created in; pi scopes a session to it. */
  workspacePath?: string;
}

interface IndexFile {
  version: 1;
  /** No notion of "the current one": which conversation is open is UI state. */
  sessions: SessionEntry[];
}

const UNTITLED = "新会话";
const TITLE_LIMIT = 48;

export class SessionStore {
  #path: string;
  #file: IndexFile;

  constructor(path: string) {
    this.#path = path;
    this.#file = read(path);
  }

  /** Most recently active first. */
  list(): SessionEntry[] {
    return [...this.#file.sessions].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * Record a session under an id that was already handed to pi.
   *
   * New conversations are drafts: the id exists before the index entry does, so
   * a draft that never gets a message leaves nothing behind.
   */
  createWithId(id: string, workspacePath?: string): string {
    const now = Date.now();
    this.#file.sessions.push({ id, title: UNTITLED, createdAt: now, updatedAt: now, workspacePath });
    this.#write();
    return id;
  }

  get(id: string): SessionEntry | undefined {
    return this.#find(id);
  }

  /** Remember the model a session runs on, so reopening it keeps that choice. */
  setModel(id: string, provider: string, modelId: string): void {
    const entry = this.#find(id);
    if (!entry) return;
    if (entry.model?.provider === provider && entry.model.id === modelId) return;
    entry.model = { provider, id: modelId };
    this.#write();
  }

  /** Remember the thinking level chosen for a session. */
  setThinkingLevel(id: string, level: string): void {
    const entry = this.#find(id);
    if (!entry || entry.thinkingLevel === level) return;
    entry.thinkingLevel = level;
    this.#write();
  }

  /**
   * Record activity. The title is taken from the first message of a session
   * that has not been named yet — no transcript parsing involved, we already
   * have the text.
   */
  touch(id: string, firstMessage?: string): void {
    const entry = this.#find(id);
    if (!entry) return;
    entry.updatedAt = Date.now();
    if (entry.title === UNTITLED && firstMessage) entry.title = titleFrom(firstMessage);
    this.#write();
  }

  /**
   * Forget a session and hand back what was recorded, so the caller can delete
   * the transcript it pointed at. Nothing is removed without this being asked.
   */
  remove(id: string): SessionEntry | undefined {
    const index = this.#file.sessions.findIndex((entry) => entry.id === id);
    if (index === -1) return undefined;
    const [entry] = this.#file.sessions.splice(index, 1);
    this.#write();
    return entry;
  }

  /** Remember which transcript pi opened for this session. */
  attachFile(id: string, sessionFile: string | undefined): void {
    if (!sessionFile) return;
    // Stored as a file name, not pi's absolute path: the index stays valid if
    // the data directory is moved or restored somewhere else.
    const name = basename(sessionFile);
    const entry = this.#find(id);
    if (!entry || entry.sessionFile === name) return;
    entry.sessionFile = name;
    this.#write();
  }

  #find(id: string): SessionEntry | undefined {
    return this.#file.sessions.find((entry) => entry.id === id);
  }

  #write(): void {
    try {
      if (!existsSync(dirname(this.#path))) mkdirSync(dirname(this.#path), { recursive: true });
      // Rename is atomic within a directory: a crash leaves the old index, never
      // a half-written one.
      const temporary = `${this.#path}.tmp`;
      writeFileSync(temporary, JSON.stringify(this.#file, null, 2));
      renameSync(temporary, this.#path);
    } catch {
      // Losing the index costs the list, never a transcript.
    }
  }
}

function read(path: string): IndexFile {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<IndexFile> | null;
    if (raw?.version === 1 && Array.isArray(raw.sessions)) {
      return { version: 1, sessions: raw.sessions.filter(isEntry) };
    }
  } catch {
    // Missing or unreadable: start clean. Nothing else reads this file, so an
    // unexpected shape is not worth guessing at.
  }
  return { version: 1, sessions: [] };
}

function isEntry(value: unknown): value is SessionEntry {
  const entry = value as Partial<SessionEntry> | null;
  return (
    typeof entry?.id === "string" &&
    typeof entry.title === "string" &&
    typeof entry.createdAt === "number" &&
    typeof entry.updatedAt === "number"
  );
}

function titleFrom(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (!line) return UNTITLED;
  return line.length > TITLE_LIMIT ? `${line.slice(0, TITLE_LIMIT)}…` : line;
}
