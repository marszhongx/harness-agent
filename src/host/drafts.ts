/**
 * The conversation that does not exist yet.
 *
 * "New conversation" must not write anything — no index entry, no process — so
 * the app mints the id pi will use and keeps it here until the first message.
 * Choices made before that point (folder, model, thinking level) live here too,
 * because there is nowhere else to put them yet.
 *
 * Kept free of electron and of the session index so the lifecycle can be tested
 * as plain state: the caller decides what "record it" means.
 */
export interface DraftModel {
  provider: string;
  id: string;
}

export interface Draft {
  id: string;
  workspacePath: string;
  /** The model the draft will run with unless another is picked. */
  model: DraftModel | null;
  thinkingLevel?: string;
}

export interface Promotion {
  id: string;
  workspacePath: string;
  model: DraftModel | null;
  thinkingLevel?: string;
}

export class Drafts {
  #draft: Draft | null = null;
  /** Folder picked on the new-conversation page, for the next draft. */
  #workspace: string | null = null;
  /** Choices made while the page had no id at all. */
  #model: DraftModel | null = null;
  #thinkingLevel: string | null = null;

  /** `null` means "back to the app's default folder". */
  chooseWorkspace(path: string | null): string | null {
    this.#workspace = path;
    if (this.#draft) this.#draft.workspacePath = path ?? this.#draft.workspacePath;
    return this.#workspace;
  }

  workspacePath(fallback: string): string {
    return this.#draft?.workspacePath ?? this.#workspace ?? fallback;
  }

  /** Mint the id pi will use, remembering what the page already chose. */
  begin(id: string, defaultModel: DraftModel | null, fallbackWorkspace: string): Draft {
    const draft: Draft = {
      id,
      workspacePath: this.#workspace ?? fallbackWorkspace,
      model: this.#model ?? defaultModel,
    };
    if (this.#thinkingLevel) draft.thinkingLevel = this.#thinkingLevel;
    this.#draft = draft;
    return draft;
  }

  current(): Draft | null {
    return this.#draft;
  }

  /** True while this id belongs to the draft and not to the index. */
  holds(id: string | null): boolean {
    return Boolean(id) && this.#draft?.id === id;
  }

  /**
   * A model or thinking level picked for the new-conversation page, which has
   * no id yet — `sessionId` is null there.
   */
  chooseModel(sessionId: string | null, model: DraftModel): void {
    if (sessionId && !this.holds(sessionId)) return;
    this.#model = model;
    if (this.#draft) this.#draft.model = model;
  }

  chooseThinkingLevel(sessionId: string | null, level: string): void {
    if (sessionId && !this.holds(sessionId)) return;
    this.#thinkingLevel = level;
    if (this.#draft) this.#draft.thinkingLevel = level;
  }

  /** What the draft would run on, so `status` can answer before the first turn. */
  modelFor(id: string): DraftModel | null {
    return this.holds(id) ? (this.#draft?.model ?? this.#model) : null;
  }

  /**
   * The first message arrived: hand back everything needed to record the
   * conversation, and forget the draft so the next page starts clean.
   */
  promote(fallbackModel: DraftModel | null): Promotion | null {
    const draft = this.#draft;
    if (!draft) return null;
    const promotion: Promotion = {
      id: draft.id,
      workspacePath: draft.workspacePath,
      model: this.#model ?? draft.model ?? fallbackModel,
    };
    const thinkingLevel = this.#thinkingLevel ?? draft.thinkingLevel;
    if (thinkingLevel) promotion.thinkingLevel = thinkingLevel;

    this.#draft = null;
    this.#model = null;
    this.#thinkingLevel = null;
    this.#workspace = null;
    return promotion;
  }

  /** The conversation was deleted (or the app is shutting a draft down). */
  forget(id: string): void {
    if (this.holds(id)) this.#draft = null;
  }
}
