import { beforeEach, describe, expect, it } from "vitest";
import { type DraftModel, Drafts } from "./drafts.ts";

const sonnet: DraftModel = { provider: "hifox", id: "sonnet" };
const flash: DraftModel = { provider: "hifox", id: "flash" };

let drafts: Drafts;

beforeEach(() => {
  drafts = new Drafts();
});

describe("Drafts", () => {
  it("uses the app's folder unless one was picked", () => {
    expect(drafts.begin("d1", sonnet, "/default").workspacePath).toBe("/default");

    drafts.chooseWorkspace("/picked");
    expect(drafts.begin("d2", sonnet, "/default").workspacePath).toBe("/picked");
  });

  it("keeps a picked folder when the draft already exists", () => {
    drafts.begin("d1", sonnet, "/default");
    drafts.chooseWorkspace("/picked");

    expect(drafts.current()?.workspacePath).toBe("/picked");
    expect(drafts.workspacePath("/default")).toBe("/picked");
  });

  it("holds one draft at a time, and only for its own id", () => {
    drafts.begin("d1", sonnet, "/default");
    drafts.begin("d2", sonnet, "/default");

    expect(drafts.holds("d2")).toBe(true);
    expect(drafts.holds("d1")).toBe(false);
    expect(drafts.holds(null)).toBe(false);
    expect(drafts.current()?.id).toBe("d2");
  });

  it("remembers choices made before the page had an id", () => {
    drafts.chooseModel(null, flash);
    drafts.chooseThinkingLevel(null, "max");

    const draft = drafts.begin("d1", sonnet, "/default");
    expect(draft.model).toEqual(flash);
    expect(draft.thinkingLevel).toBe("max");

    const promotion = drafts.promote(sonnet);
    expect(promotion).toMatchObject({ id: "d1", model: flash, thinkingLevel: "max" });
  });

  it("prefers the page's choice over the draft's own model", () => {
    drafts.chooseModel(null, flash);
    drafts.begin("d1", null, "/default");
    drafts.chooseModel("d1", sonnet);

    expect(drafts.promote(null)?.model).toEqual(sonnet);
  });

  it("falls back to the default model when nothing was picked", () => {
    drafts.begin("d1", null, "/default");
    expect(drafts.promote(flash)?.model).toEqual(flash);
  });

  it("ignores a choice made for a conversation that is not the draft", () => {
    drafts.begin("d1", sonnet, "/default");
    drafts.chooseModel("other", flash);
    drafts.chooseThinkingLevel("other", "low");

    const promotion = drafts.promote(null);
    expect(promotion?.model).toEqual(sonnet);
    expect(promotion?.thinkingLevel).toBeUndefined();
  });

  it("clears everything once promoted", () => {
    drafts.chooseWorkspace("/picked");
    drafts.chooseModel(null, flash);
    drafts.chooseThinkingLevel(null, "high");
    drafts.begin("d1", sonnet, "/default");

    const promotion = drafts.promote(sonnet);
    expect(promotion).toMatchObject({ id: "d1", workspacePath: "/picked" });

    expect(drafts.current()).toBeNull();
    expect(drafts.promote(sonnet)).toBeNull();
    // The next draft starts from the app's default again.
    expect(drafts.begin("d2", sonnet, "/default")).toMatchObject({
      workspacePath: "/default",
      model: sonnet,
    });
    expect(drafts.current()?.thinkingLevel).toBeUndefined();
  });

  it("reports the draft's model for status, and nothing for other ids", () => {
    drafts.begin("d1", sonnet, "/default");

    expect(drafts.modelFor("d1")).toEqual(sonnet);
    expect(drafts.modelFor("other")).toBeNull();
  });

  it("forgets a draft that was deleted", () => {
    drafts.begin("d1", sonnet, "/default");
    drafts.forget("other");
    expect(drafts.current()?.id).toBe("d1");

    drafts.forget("d1");
    expect(drafts.current()).toBeNull();
  });
});
