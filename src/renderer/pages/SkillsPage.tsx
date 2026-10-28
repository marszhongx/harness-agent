import { useState } from "react";
import { InfoIcon, RefreshIcon, TrashIcon } from "../components/Icons";
import SkillDetails from "../components/SkillDetails";
import type { SkillSummary } from "../lib/agent";
import { getSkill, useSkill, useSkillSync } from "../store/skill";
import ui from "../styles/ui.module.css";

/**
 * Lists what pi would discover. The app never parses skills itself — it only
 * reads the same directories and can open one in the file manager.
 *
 * The list lives in the skills store: deleting a skill updates the store, and
 * the page reads it back through a subscription rather than holding its own copy.
 */
export default function SkillsPage() {
  const skills = useSkill((state) => state.list);
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState<SkillSummary | null>(null);
  useSkillSync();

  const failure = (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause));

  const load = () => {
    setError(null);
    void getSkill().load().catch(failure);
  };

  return (
    <section className={ui.view}>
      <div className={ui.page}>
        <div className={ui.pageHead}>
          <h2>技能</h2>
          <div className={ui.row}>
            <button
              type="button"
              className={ui.iconBtn}
              aria-label="重新读取"
              title="重新读取技能目录"
              onClick={load}
            >
              <RefreshIcon />
            </button>
          </div>
        </div>
        {error ? <p className={ui.error}>{error}</p> : null}

        <div className={ui.cardList}>
          {skills.length === 0 ? (
            <div className={`${ui.card} ${ui.empty}`}>还没有技能，点右上角的 + 新建一个。</div>
          ) : null}
          {skills.map((skill) => (
            <div className={ui.card} key={skill.dir}>
              <div className={ui.cardHead}>
                <span className={ui.cardTitle}>{skill.name}</span>
                <span className={ui.badge}>{skill.scope === "project" ? "项目" : "用户"}</span>
                {skill.manualOnly ? <span className={`${ui.badge} ${ui.warn}`}>仅手动调用</span> : null}
                <span className={ui.spacer} />
                <button
                  type="button"
                  className={ui.iconBtn}
                  aria-label={`查看 ${skill.name} 详情`}
                  title="查看详情"
                  onClick={() => setOpened(skill)}
                >
                  <InfoIcon />
                </button>
                <button
                  type="button"
                  className={`${ui.iconBtn} ${ui.danger}`}
                  aria-label={`删除 ${skill.name}`}
                  title="删除"
                  onClick={() => {
                    setError(null);
                    void getSkill().remove(skill.dir).catch(failure);
                  }}
                >
                  <TrashIcon />
                </button>
              </div>
              <div className={`${ui.cardSub} ${ui.clamp2}`} title={skill.description}>
                {skill.description}
              </div>
            </div>
          ))}
        </div>
      </div>
      {opened ? <SkillDetails skill={opened} onClose={() => setOpened(null)} /> : null}
    </section>
  );
}
