import { useCallback, useEffect, useState } from "react";
import { ElectronIcon, NodeIcon } from "../components/Icons";
import Logo from "../components/Logo";
import { agent, type SettingsSnapshot } from "../lib/agent";
import ui from "../styles/ui.module.css";

/**
 * Settings as groups of label/control rows: every row is a peer, and the panel
 * frame is drawn once per group.
 */
export default function SettingsPage() {
  const [state, setState] = useState<SettingsSnapshot | null>(null);

  const load = useCallback(async () => setState(await agent().settings()), []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!state) return <section className={ui.view} />;

  return (
    <section className={ui.view}>
      <div className={ui.page}>
        <div className={ui.pageHead}>
          <h2>设置</h2>
        </div>

        <div className={ui.cardList}>
          <div className={ui.settingRow}>
            <div className={ui.settingLabel}>主题</div>
            <div className={ui.settingBody}>
              <select
                className={ui.fieldInput}
                aria-label="主题"
                value={state.theme}
                onChange={(event) => {
                  const theme = event.currentTarget.value as "system" | "light" | "dark";
                  void agent().setTheme(theme).then(setState);
                }}
              >
                <option value="system">跟随系统</option>
                <option value="light">浅色</option>
                <option value="dark">深色</option>
              </select>
            </div>
          </div>

          <div className={ui.settingRow}>
            <div className={ui.settingLabel}>启动</div>
            <div className={ui.settingBody}>
              <label className={ui.checkRow}>
                <input
                  type="checkbox"
                  checked={state.launchAtLogin}
                  onChange={(event) => {
                    void agent().setLaunchAtLogin(event.currentTarget.checked).then(setState);
                  }}
                />
                <span>登录时自动启动</span>
              </label>
            </div>
          </div>
        </div>

        <div className={ui.groupTitle}>数据</div>
        <div className={ui.cardList}>
          <div className={ui.settingRow}>
            <div className={ui.settingLabel}>默认工作空间</div>
            <div className={ui.settingBody}>
              <button
                type="button"
                className={ui.pathButton}
                title={`在访达中打开 ${state.workspacePath}`}
                onClick={() => void agent().revealPath(state.workspacePath)}
              >
                {state.workspacePath}
              </button>
            </div>
          </div>

          <div className={ui.settingRow}>
            <div className={ui.settingLabel}>会话记录</div>
            <div className={ui.settingBody}>
              <button
                type="button"
                className={ui.pathButton}
                title={`在访达中打开 ${state.sessionsDir}`}
                onClick={() => void agent().revealPath(state.sessionsDir)}
              >
                {state.sessionsDir}
              </button>
            </div>
          </div>

          <div className={ui.settingRow}>
            <div className={ui.settingLabel}>运行日志</div>
            <div className={ui.settingBody}>
              <button
                type="button"
                className={ui.pathButton}
                title={`在访达中打开 ${state.logsDir}`}
                onClick={() => void agent().revealPath(state.logsDir)}
              >
                {state.logsDir}
              </button>
            </div>
          </div>
        </div>

        <div className={ui.groupTitle}>关于</div>
        <div className={ui.cardList}>
          <div className={ui.settingRow}>
            <div className={ui.settingLabel}>版本</div>
            <div className={ui.settingBody}>
              <div className={ui.versionRow}>
                <span className={ui.versionItem}>
                  <Logo size={16} />
                  <span className={ui.versionLabel}>{state.appName}</span>
                  <span className={ui.versionValue}>{state.appVersion}</span>
                </span>
                <span className={ui.versionItem}>
                  <ElectronIcon />
                  <span className={ui.versionLabel}>Electron</span>
                  <span className={ui.versionValue}>{state.electronVersion}</span>
                </span>
                <span className={ui.versionItem}>
                  <NodeIcon />
                  <span className={ui.versionLabel}>Node</span>
                  <span className={ui.versionValue}>{state.nodeVersion}</span>
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
