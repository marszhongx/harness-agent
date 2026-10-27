import { useEffect, useLayoutEffect, useRef, useState } from "react";
import ApprovalCard from "../components/ApprovalCard";
import Composer from "../components/Composer";
import Transcript from "../components/Transcript";
import type { DialogRequest, PromptImage, UiAnswer } from "../lib/agent";
import { agent } from "../lib/agent";
import { nextItemId } from "../store/items";
import { getSessions } from "../store/sessions";
import { getTranscripts, historyToItems, useTranscriptSync, useTranscripts } from "../store/transcript";
import layout from "../styles/layout.module.css";
import ui from "../styles/ui.module.css";

interface ChatPageProps {
  /** `null` on the new-conversation page: nothing exists until the first message. */
  sessionId: string | null;
  /** Mints an id the first time a message needs one. */
  onEnsureSession: () => Promise<string>;
}

interface PendingDialog {
  requestId: string;
  request: DialogRequest;
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
  const items = useTranscripts((state) => state.getItems(sessionId));
  const busy = useTranscripts((state) => state.getBusy(sessionId));
  useTranscriptSync();
  const [dialog, setDialog] = useState<PendingDialog | null>(null);
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
  useEffect(() => {
    stick.current = true;
  }, [sessionId]);

  // Lines grow by a few characters at a time, so this runs often; it is a single
  // assignment, and skipping it while the user reads keeps the view still.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && stick.current) element.scrollTop = element.scrollHeight;
  }, [items]);

  // Opening a conversation loads its transcript from disk. The cache wins when
  // the conversation was already on screen (or is a draft that just started).
  useEffect(() => {
    if (!sessionId) return;
    if (getTranscripts().getItems(sessionId).length > 0) return;
    void (async () => {
      const history = await agent().history(sessionId);
      if (history && history.length > 0) getTranscripts().replace(sessionId, historyToItems(history));
    })();
  }, [sessionId]);

  // Approval requests belong to whichever conversation is open.
  useEffect(
    () => agent().onDialog(({ requestId, dialog: request }) => setDialog({ requestId, request })),
    [],
  );

  const answer = (value: UiAnswer) => {
    const pending = dialog;
    setDialog(null);
    if (pending) void agent().answer(pending.requestId, value);
  };

  const send = async (text: string, images?: PromptImage[]) => {
    // Sending is the user asking to see the answer: follow it down even if they
    // were reading further up.
    stick.current = true;
    const id = sessionId ?? (await onEnsureSession());
    const transcripts = getTranscripts();
    transcripts.setBusy(id, true);
    transcripts.append(id, { id: nextItemId(), kind: "user", text, images });
    try {
      await agent().prompt(id, text, images);
    } catch (cause) {
      transcripts.setBusy(id, false);
      transcripts.append(id, { id: nextItemId(), kind: "notice", text: readableError(cause), error: true });
    }
    void getSessions().refresh();
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
          {dialog ? <ApprovalCard dialog={dialog.request} onAnswer={answer} /> : null}
        </div>
      </div>

      <Composer sessionId={sessionId} busy={busy} onSend={send} />
    </section>
  );
}
