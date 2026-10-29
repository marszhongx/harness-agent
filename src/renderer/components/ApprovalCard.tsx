import { useState } from "react";
import type { DialogRequest, UiAnswer } from "../lib/agent";
import ui from "../styles/ui.module.css";
import { WarningIcon } from "./Icons";

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
  // The card is keyed by request id wherever it is rendered, so this runs once
  // per dialog. An editor starts from what pi offered to edit.
  const [value, setValue] = useState(dialog.method === "editor" ? (dialog.prefill ?? "") : "");
  const request = dialog;
  const subtitle =
    request.method === "confirm"
      ? request.message
      : request.method === "input"
        ? (request.placeholder ?? "")
        : "";

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
          <WarningIcon size={15} />
          <span>{request.title || "需要确认"}</span>
        </h3>
        {subtitle ? <p>{subtitle}</p> : null}

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
            placeholder={request.method === "input" ? (request.placeholder ?? "") : ""}
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
