import { memo, useState } from "react";
import ui from "../styles/ui.module.css";

interface ToolCardProps {
  name: string;
  summary?: string;
  text?: string;
  isError?: boolean;
  durationMs?: number;
  running: boolean;
}

/**
 * One tool call. Collapsed by default; a failure opens itself because the reason
 * is the only thing the user wants from it.
 */
// Primitive props only, so a re-render of the transcript never re-renders a card.
export default memo(function ToolCard({ name, summary, text, isError, durationMs, running }: ToolCardProps) {
  const [open, setOpen] = useState(false);
  const expanded = open || Boolean(isError) || Boolean(text && running);
  const state = running ? "running" : isError ? "error" : "done";

  return (
    <div className={`${ui.toolCard} ${expanded ? ui.open : ""}`} data-state={state}>
      <button type="button" className={ui.toolHead} onClick={() => setOpen((value) => !value)}>
        <svg
          aria-hidden="true"
          focusable="false"
          className={ui.chev}
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.6"
          strokeLinecap="round"
        >
          <path d="m9 18 6-6-6-6" />
        </svg>
        <span className={ui.toolName}>{name}</span>
        {summary ? <span className={ui.toolSummary}>{summary}</span> : null}
        <span className={ui.toolStatus}>
          {running ? "" : isError ? "失败" : typeof durationMs === "number" ? `${durationMs}ms` : ""}
        </span>
      </button>
      {text ? <pre className={ui.toolOutput}>{text}</pre> : null}
    </div>
  );
});
