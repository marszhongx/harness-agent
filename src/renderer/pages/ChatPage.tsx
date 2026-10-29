import { useEffect, useLayoutEffect, useRef } from "react";
import ApprovalCard from "../components/ApprovalCard";
import Composer from "../components/Composer";
import Transcript from "../components/Transcript";
import type { PromptImage, UiAnswer } from "../lib/agent";
import { agent } from "../lib/agent";
import { getDialog, useDialog } from "../store/dialog";
import { nextItemId } from "../store/item";
import { getSession } from "../store/session";
import { getTranscript, historyToItems, useTranscript } from "../store/transcript";
import layout from "../styles/layout.module.css";
import ui from "../styles/ui.module.css";

interface ChatPageProps {
  /** `null` on the new-conversation page: nothing exists until the first message. */
  sessionId: string | null;
  /** Mints an id the first time a message needs one. */
  onEnsureSession: () => Promise<string>;
}

/**
 * Electron wraps a rejected IPC call in its own sentence; the reason the user
 * needs is at the end of it.
 */
function readableError(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : String(cause);
  return text.replace(/^Error invoking remote method '[^']+':\s*/, "").replace(/^Error:\s*/, "");
}

/** The conversation view: transcript above, composer below. */
export default function ChatPage({ sessionId, onEnsureSession }: ChatPageProps) {
  // One value per subscription: a busy flip never invalidates the line list.
  const items = useTranscript((state) => state.getItems(sessionId));
  const busy = useTranscript((state) => state.getBusy(sessionId));
  // The queue lives above this page: the request has to survive navigation, and
  // only the one belonging to this conversation is shown here.
  const dialog = useDialog((state) => state.getFor(sessionId));
  const scroller = useRef<HTMLDivElement>(null);
  // Follow the bottom while the user has not scrolled away from it.
  const stick = useRef(true);

  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const onScroll = () => {
      stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => element.removeEventListener("scroll", onScroll);
  }, []);

  // A new conversation starts at its end, whatever the last one was doing.
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionId is the trigger; the effect only mutates a ref
  useEffect(() => {
    stick.current = true;
  }, [sessionId]);

  // Lines grow by a few characters at a time, so this runs often; it is a single
  // assignment, and skipping it while the user reads keeps the view still.
  // biome-ignore lint/correctness/useExhaustiveDependencies: items is the trigger; the effect only reads refs and the DOM
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && stick.current) element.scrollTop = element.scrollHeight;
  }, [items]);

  // Opening a conversation loads its transcript from disk. The cache wins when
  // the conversation was already on screen (or is a draft that just started).
  useEffect(() => {
    if (!sessionId) return;
    if (getTranscript().getItems(sessionId).length > 0) return;
    let cancelled = false;
    void (async () => {
      const history = await agent().history(sessionId);
      if (cancelled || !history || history.length === 0) return;
      const restored = historyToItems(history);
      const current = getTranscript().getItems(sessionId);
      // The user may have sent a message while the file was being read; the
      // new activity belongs after the restored lines, not under them.
      getTranscript().replace(sessionId, [...restored, ...current]);
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  // Approval requests are global (see `store/dialog.ts`); answering removes
  // the current one so a queued request can take its place.
  const answer = (value: UiAnswer) => {
    if (dialog) getDialog().answer(dialog, value);
  };

  const send = async (text: string, images?: PromptImage[]) => {
    // Sending is the user asking to see the answer: follow it down even if they
    // were reading further up.
    stick.current = true;
    const id = sessionId ?? (await onEnsureSession());
    const transcripts = getTranscript();
    transcripts.setBusy(id, true);
    transcripts.append(id, { id: nextItemId(), kind: "user", text, images });
    try {
      await agent().prompt(id, text, images);
    } catch (cause) {
      transcripts.setBusy(id, false);
      transcripts.append(id, { id: nextItemId(), kind: "notice", text: readableError(cause), error: true });
    }
    void getSession().refresh();
  };

  return (
    <section className={ui.view} data-session-id={sessionId ?? ""}>
      {/* Title bar is hidden, so the top of the page doubles as the window's drag area. */}
      <div className={layout.topbar} />

      <div className={layout.scroll} ref={scroller}>
        <div className={layout.column}>
          {items.length === 0 ? (
            <div className={layout.welcome}>
              <h1>我能为你做些什么？</h1>
            </div>
          ) : null}
          <Transcript items={items} />
          {dialog ? <ApprovalCard key={dialog.requestId} dialog={dialog.request} onAnswer={answer} /> : null}
        </div>
      </div>

      <Composer key={sessionId ?? "draft"} sessionId={sessionId} busy={busy} onSend={send} />
    </section>
  );
}
