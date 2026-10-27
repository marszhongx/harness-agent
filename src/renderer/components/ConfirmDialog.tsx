import { useEffect } from "react";
import ui from "../styles/ui.module.css";

/** One question, two answers. Used before anything is deleted for good. */
export default function ConfirmDialog({
  title,
  message,
  confirmLabel = "删除",
  onConfirm,
  onCancel,
}: {
  title: string;
  message: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div className={ui.overlay}>
      <button type="button" className={ui.overlayClose} aria-label="取消" onClick={onCancel} />
      <div className={ui.dialog} role="alertdialog" aria-modal="true" aria-label={title}>
        <div className={ui.dialogHead}>
          <span className={ui.cardTitle}>{title}</span>
        </div>
        <div className={ui.dialogBody}>{message}</div>
        <div className={ui.dialogActions}>
          <button type="button" className={ui.btn} onClick={onCancel}>
            取消
          </button>
          <button type="button" className={`${ui.btn} ${ui.dangerSolid}`} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
