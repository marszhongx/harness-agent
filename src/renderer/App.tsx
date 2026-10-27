import { useCallback, useState } from "react";
import Sidebar, { type View } from "./components/Sidebar";
import { agent } from "./lib/agent";
import ChatPage from "./pages/ChatPage";
import ModelsPage from "./pages/ModelsPage";
import SettingsPage from "./pages/SettingsPage";
import SkillsPage from "./pages/SkillsPage";
import { getSessions } from "./store/sessions";
import { getTranscripts } from "./store/transcript";
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

  /** Called by the composer when the first message needs an id. */
  const ensureSession = useCallback(async () => {
    if (sessionId) return sessionId;
    const created = await agent().newSession();
    setSessionId(created);
    void getSessions().refresh();
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
          getTranscripts().drop(id);
        }}
      />
      <main className={layout.main}>
        {view === "chat" && <ChatPage sessionId={sessionId} onEnsureSession={ensureSession} />}
        {view === "models" && <ModelsPage />}
        {view === "skills" && <SkillsPage />}
        {view === "settings" && <SettingsPage />}
      </main>
    </>
  );
}
