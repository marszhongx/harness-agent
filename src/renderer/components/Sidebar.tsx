import { useEffect, useRef, useState } from "react";
import { agent, relativeTime, type SessionSummary } from "../lib/agent";
import { getSessions, useSessions, useSessionsSync } from "../store/sessions";
import { useTranscripts } from "../store/transcript";
import layout from "../styles/layout.module.css";
import ConfirmDialog from "./ConfirmDialog";
import { TrashIcon } from "./Icons";

export type View = "chat" | "models" | "skills" | "settings";

interface SidebarProps {
  view: View;
  onNavigate: (view: View) => void;
  /** The conversation on screen; `null` on the new-conversation page. */
  sessionId: string | null;
  onOpenSession: (id: string) => void;
  onNewConversation: () => void;
  /** Called after a conversation is deleted, so a stale view can be dropped. */
  onSessionDeleted: (id: string) => void;
}

const NAV: Array<{ view: View; label: string; icon: string }> = [
  { view: "models", label: "模型", icon: "M4 4h16v16H4z M9 9h6v6H9z" },
  {
    view: "skills",
    label: "技能",
    icon: "M12 12a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M12 2v4 M12 18v4 M2 12h4 M18 12h4 M5 5l3 3 M16 16l3 3 M19 5l-3 3 M8 16l-3 3",
  },
];

/** Announced but not built yet: shown so the shape of the app is visible. */
const SOON: Array<{ label: string; icon: string }> = [
  { label: "Agents", icon: "M4 7h16v12H4z M12 7V4 M9 12h.01 M15 12h.01" },
  { label: "定时任务", icon: "M12 7v5l3 2 M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z" },
];

/** Collapsible sidebar: navigation plus the conversation list. */
export default function Sidebar({
  view,
  onNavigate,
  sessionId,
  onOpenSession,
  onNewConversation,
  onSessionDeleted,
}: SidebarProps) {
  const sessions = useSessions((state) => state.list);
  // Only the busy flags: a streaming answer must not re-render the list.
  const busy = useTranscripts((state) => state.busy);
  useSessionsSync();
  const [collapsed, setCollapsed] = useState(false);
  const [pending, setPending] = useState<SessionSummary | null>(null);
  // Collapsed, the list has no room: an icon in the rail opens it instead.
  const [flyout, setFlyout] = useState(false);
  const flyoutAnchor = useRef<HTMLDivElement>(null);
  // The new-conversation page is the one with no session id; nothing to compare.
  const onNewPage = view === "chat" && sessionId === null;

  useEffect(() => {
    if (!flyout) return;
    const onPointer = (event: MouseEvent) => {
      if (!flyoutAnchor.current?.contains(event.target as Node)) setFlyout(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFlyout(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [flyout]);

  const sessionItem = (session: SessionSummary, onPick: () => void) => (
    <button
      key={session.id}
      type="button"
      className={`${layout.session} ${session.id === sessionId ? layout.active : ""}`}
      aria-current={session.id === sessionId ? "page" : undefined}
      onClick={onPick}
    >
      <div className={layout.sessionTitle}>{session.title}</div>
      {busy.get(session.id) ? (
        <div className={layout.sessionRunning}>
          <span className={layout.sessionDot} />
          正在回答
        </div>
      ) : (
        <div className={layout.sessionTime}>{relativeTime(session.updatedAt)}</div>
      )}
    </button>
  );

  return (
    <aside className={`${layout.sidebar} ${collapsed ? layout.sidebarCollapsed : ""}`}>
      <div className={layout.dragChrome} />
      <div className={layout.sidebarHead}>
        <div className={layout.logo}>
          <div className={layout.logoMark} />
          <span className={layout.logoName}>harness-agent</span>
        </div>
        <button
          type="button"
          className={layout.iconBtn}
          onClick={() => {
            setCollapsed((value) => !value);
            setFlyout(false);
          }}
          title={collapsed ? "展开侧边栏" : "收起侧边栏"}
          aria-label={collapsed ? "展开侧边栏" : "收起侧边栏"}
        >
          <svg
            aria-hidden="true"
            focusable="false"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <path d="M9 3v18" />
          </svg>
        </button>
      </div>

      <nav className={layout.nav}>
        <button
          type="button"
          className={`${layout.navItem} ${onNewPage ? layout.active : ""}`}
          aria-current={onNewPage ? "page" : undefined}
          onClick={onNewConversation}
        >
          <svg
            aria-hidden="true"
            focusable="false"
            className={layout.icon}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <path d="M12 5v14M5 12h14" />
          </svg>
          <span className={layout.label}>新对话</span>
        </button>
        {NAV.map((item) => (
          <button
            key={item.view}
            type="button"
            className={`${layout.navItem} ${view === item.view ? layout.active : ""}`}
            aria-current={view === item.view ? "page" : undefined}
            onClick={() => onNavigate(item.view)}
          >
            <svg
              aria-hidden="true"
              focusable="false"
              className={layout.icon}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <path d={item.icon} />
            </svg>
            <span className={layout.label}>{item.label}</span>
          </button>
        ))}
        {SOON.map((item) => (
          <button
            key={item.label}
            type="button"
            className={layout.navItem}
            data-soon
            disabled
            title="即将推出"
          >
            <svg
              aria-hidden="true"
              focusable="false"
              className={layout.icon}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <path d={item.icon} />
            </svg>
            <span className={layout.label}>{item.label}</span>
            <span className={layout.tag}>Coming soon</span>
          </button>
        ))}
        {collapsed ? (
          <div className={layout.flyoutAnchor} ref={flyoutAnchor}>
            <button
              type="button"
              className={`${layout.navItem} ${flyout ? layout.active : ""}`}
              aria-label="最近会话"
              aria-expanded={flyout}
              title="最近会话"
              onClick={() => setFlyout((open) => !open)}
            >
              <svg
                aria-hidden="true"
                focusable="false"
                className={layout.icon}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M3 12a9 9 0 1 0 3-6.7" />
                <path d="M3 4v4.5h4.5" />
                <path d="M12 8v4.3l3 1.8" />
              </svg>
            </button>

            {flyout ? (
              <div className={layout.flyout} role="dialog" aria-label="最近会话">
                <div className={layout.flyoutHead}>最近会话</div>
                {sessions.length === 0 ? <div className={layout.sessionEmpty}>还没有会话</div> : null}
                {sessions.map((session) =>
                  sessionItem(session, () => {
                    onOpenSession(session.id);
                    setFlyout(false);
                  }),
                )}
              </div>
            ) : null}
          </div>
        ) : null}
      </nav>

      <div className={layout.section}>
        <div className={layout.sectionHead}>
          <span>最近会话</span>
        </div>
        <div className={layout.sessionList}>
          {sessions.length === 0 && <div className={layout.sessionEmpty}>还没有会话</div>}
          {sessions.map((session) => (
            <div
              key={session.id}
              className={`${layout.sessionRow} ${session.id === sessionId ? layout.active : ""}`}
            >
              {sessionItem(session, () => onOpenSession(session.id))}
              <button
                type="button"
                className={`${layout.iconBtn} ${layout.sessionDelete}`}
                aria-label={`删除会话 ${session.title}`}
                title="删除会话"
                onClick={() => setPending(session)}
              >
                <TrashIcon />
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className={layout.sidebarFoot}>
        <button
          type="button"
          className={`${layout.navItem} ${view === "settings" ? layout.active : ""}`}
          aria-current={view === "settings" ? "page" : undefined}
          onClick={() => onNavigate("settings")}
        >
          <svg
            aria-hidden="true"
            focusable="false"
            className={layout.icon}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <circle cx="12" cy="12" r="3" />
            <path d="M4 12h2M18 12h2M12 4v2M12 18v2" />
          </svg>
          <span className={layout.label}>设置</span>
        </button>
      </div>

      {pending ? (
        <ConfirmDialog
          title="删除这段对话？"
          message={`「${pending.title}」的聊天记录会一起删除，不能恢复。`}
          onCancel={() => setPending(null)}
          onConfirm={() => {
            const id = pending.id;
            setPending(null);
            void agent()
              .deleteSession(id)
              .then(() => getSessions().refresh())
              .then(() => onSessionDeleted(id));
          }}
        />
      ) : null}
    </aside>
  );
}
