import { useEffect, useState } from "react";
import type { SkillSummary } from "../lib/agent";
import { agent } from "../lib/agent";
import ui from "../styles/ui.module.css";
import { CloseIcon } from "./Icons";

/**
 * The whole SKILL.md, because the row only has room for two lines and the file
 * is what a skill actually is. Nothing here edits it — the folder is a file away.
 */
export default function SkillDetails({ skill, onClose }: { skill: SkillSummary; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    void agent()
      .readSkill(skill.dir)
      .then((content) => setText(content ?? "（读不到这个文件）"));
  }, [skill.dir]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className={ui.overlay}>
      {/* The backdrop is a real button, so clicking outside and the keyboard both work. */}
      <button type="button" className={ui.overlayClose} aria-label="关闭详情" onClick={onClose} />
      <div className={ui.dialog} role="dialog" aria-modal="true" aria-label={`${skill.name} 详情`}>
        <div className={ui.dialogHead}>
          <span className={ui.cardTitle}>{skill.name}</span>
          <span className={ui.badge}>{skill.scope === "project" ? "项目" : "用户"}</span>
          {skill.manualOnly ? <span className={`${ui.badge} ${ui.warn}`}>仅手动调用</span> : null}
          <span className={ui.spacer} />
          <button type="button" className={ui.iconBtn} aria-label="关闭" title="关闭" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        <div className={ui.dialogBody}>{text ?? "读取中…"}</div>
      </div>
    </div>
  );
}
