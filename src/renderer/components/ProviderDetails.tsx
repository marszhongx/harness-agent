import { type FormEvent, useEffect, useState } from "react";
import type { ProviderSummary } from "../lib/agent";
import { getModel } from "../store/model";
import ui from "../styles/ui.module.css";
import { CloseIcon } from "./Icons";
import ModelTable from "./ModelTable";
import Tag from "./Tag";

/** Provider connection settings plus its model table, in a dialog. */
export default function ProviderDetails({
  provider,
  onClose,
}: {
  provider: ProviderSummary;
  onClose: () => void;
}) {
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl);
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setBaseUrl(provider.baseUrl), [provider.baseUrl]);

  const failure = (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause));

  const saveProvider = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    try {
      await getModel().saveProvider(provider.id, {
        baseUrl: baseUrl.trim(),
        api: provider.api,
        apiKey,
      });
      setApiKey("");
    } catch (cause) {
      failure(cause);
    }
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className={ui.overlay}>
      <button type="button" className={ui.overlayClose} aria-label="关闭详情" onClick={onClose} />
      <div className={ui.dialog} role="dialog" aria-modal="true" aria-label={`${provider.id} 的模型`}>
        <div className={ui.dialogHead}>
          <span className={ui.cardTitle}>{provider.id}</span>
          <Tag>{provider.models.length} 个模型</Tag>
          <span className={ui.spacer} />
          <button type="button" className={ui.iconBtn} aria-label="关闭" title="关闭" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        <div className={ui.dialogBody}>
          <div className={ui.modelDetail}>
            <form className={ui.row} onSubmit={saveProvider}>
              <label className={`${ui.field} ${ui.wide}`}>
                <span>baseUrl</span>
                <input
                  className={ui.fieldInput}
                  value={baseUrl}
                  onChange={(event) => setBaseUrl(event.currentTarget.value)}
                  placeholder="https://host/v1"
                  required
                />
              </label>
              <label className={ui.field}>
                <span>apiKey</span>
                <input
                  className={ui.fieldInput}
                  type="password"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.currentTarget.value)}
                  placeholder="留空保持不变"
                />
              </label>
              <button type="submit" className={`${ui.btn} ${ui.primary}`}>
                保存
              </button>
            </form>

            {error ? <p className={ui.error}>{error}</p> : null}

            <ModelTable provider={provider} onError={setError} />
          </div>
        </div>
      </div>
    </div>
  );
}
