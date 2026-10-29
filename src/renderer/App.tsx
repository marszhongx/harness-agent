import { useCallback, useState } from "react";
import Sidebar, { type View } from "./components/Sidebar";
import { agent } from "./lib/agent";
import ChatPage from "./pages/ChatPage";
import ModelPage from "./pages/ModelPage";
import SettingsPage from "./pages/SettingsPage";
import SkillsPage from "./pages/SkillsPage";
import { getDialog, useDialogSync } from "./store/dialog";
import { useRunConfigEvents } from "./store/run-config";
import { getSession } from "./store/session";
import { getTranscript, useTranscriptSync } from "./store/transcript";
import layout from "./styles/layout.module.css";

/**
 * The shell owns exactly one piece of state: which conversation the window is
 * showing. `null` is the "new conversation" page — a page with no session yet.
 * Everything else (transcript lines, model choice, dialogs) belongs to the
 * component that displays it.
 */
export default function App() {
  const [view, setView] = useState<View>("chat");
  const [sessionId, setSessionId] = useState<string | null>(null);

  // These three streams cover data the whole app accumulates, not one page:
  // a background conversation keeps streaming, its model/thinking reports still
  // land, and a dialog does not disappear when the chat view unmounts.
  useTranscriptSync();
  useRunConfigEvents();
  useDialogSync();

  /** Called by the composer when the first message needs an id. */
  const ensureSession = useCallback(async () => {
    if (sessionId) return sessionId;
    const created = await agent().newSession();
    setSessionId(created);
    void getSession().refresh();
    return created;
  }, [sessionId]);

  const openSession = useCallback((id: string) => {
    setSessionId(id);
    setView("chat");
  }, []);

  const newConversation = useCallback(() => {
    setSessionId(null);
    setView("chat");
  }, []);

  return (
    <>
      <Sidebar
        view={view}
        onNavigate={setView}
        sessionId={sessionId}
        onOpenSession={openSession}
        onNewConversation={newConversation}
        onSessionDeleted={(id) => {
          if (id === sessionId) setSessionId(null);
          getTranscript().drop(id);
          getDialog().dropSession(id);
        }}
      />
      <main className={layout.main}>
        {view === "chat" && <ChatPage sessionId={sessionId} onEnsureSession={ensureSession} />}
        {view === "model" && <ModelPage />}
        {view === "skills" && <SkillsPage />}
        {view === "settings" && <SettingsPage />}
      </main>
    </>
  );
}
