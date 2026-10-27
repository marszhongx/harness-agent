import { useState } from "react";
import type { DialogRequest, UiAnswer } from "../lib/agent";
import ui from "../styles/ui.module.css";

/**
 * A dialog pi's extension asked for. It stays in the transcript until answered,
 * and blocks the run: pi waits for the reply before continuing.
 */
export default function ApprovalCard({
  dialog,
  onAnswer,
}: {
  dialog: DialogRequest;
  onAnswer: (answer: UiAnswer) => void;
}) {
  const [value, setValue] = useState("");
  const request = dialog;

  const answer = (): UiAnswer => {
    switch (request.method) {
      case "confirm":
        return { kind: "confirm", confirmed: true };
      case "select":
        return { kind: "value", value: request.options?.[0] ?? "" };
      default:
        return { kind: "value", value };
    }
  };

  const deny = (): UiAnswer =>
    request.method === "confirm" ? { kind: "confirm", confirmed: false } : { kind: "cancel" };

  return (
    <div className={ui.turn}>
      <div className={ui.approval}>
        <h3>
          <svg
            aria-hidden="true"
            focusable="false"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <path d="M12 9v4M12 17h.01" />
            <path d="M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
          </svg>
          <span>{request.title || "需要确认"}</span>
        </h3>
        <p>{request.message ?? request.placeholder ?? request.prefill ?? ""}</p>

        {request.method === "select" && request.options ? (
          <div className={ui.row}>
            {request.options.map((option) => (
              <button
                key={option}
                type="button"
                className={`${ui.btn} ${ui.small}`}
                onClick={() => onAnswer({ kind: "value", value: option })}
              >
                {option}
              </button>
            ))}
          </div>
        ) : null}

        {request.method === "input" || request.method === "editor" ? (
          <textarea
            className={`${ui.fieldInput} ${ui.fieldGrow}`}
            rows={3}
            placeholder={request.placeholder ?? ""}
            value={value}
            onChange={(event) => setValue(event.currentTarget.value)}
          />
        ) : null}

        <div className={ui.row}>
          {request.method !== "select" ? (
            <button type="button" className={`${ui.btn} ${ui.primary}`} onClick={() => onAnswer(answer())}>
              {request.method === "confirm" ? "允许" : "提交"}
            </button>
          ) : null}
          <button type="button" className={ui.btn} onClick={() => onAnswer(deny())}>
            拒绝
          </button>
        </div>
      </div>
    </div>
  );
}
