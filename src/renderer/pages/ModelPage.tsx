import { useState } from "react";
import { PlusIcon, RefreshIcon } from "../components/Icons";
import ProviderCard from "../components/ProviderCard";
import ProviderDetails from "../components/ProviderDetails";
import { getModel, useModel, useModelSync } from "../store/model";
import ui from "../styles/ui.module.css";

/**
 * `models.json` is pi's file, so this page edits it through the shared catalogue
 * store. The cards show what is saved; every model operation lives in the
 * provider's details dialog.
 */
export default function ModelPage() {
  const providers = useModel((state) => state.providers);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [detailsId, setDetailsId] = useState<string | null>(null);
  const detailProvider = detailsId ? providers.find((provider) => provider.id === detailsId) : undefined;
  // Opening the page should show the file as it is now, not a catalogue that
  // happened to be loaded at launch.
  useModelSync(true);

  const failure = (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause));

  /** Run one write and surface its failure next to the list. */
  const run = async (action: () => Promise<void>) => {
    setError(null);
    try {
      await action();
      return true;
    } catch (cause) {
      failure(cause);
      return false;
    }
  };

  const refresh = () => {
    setError(null);
    void getModel().load(true).catch(failure);
  };

  return (
    <section className={ui.view}>
      <div className={ui.page}>
        <div className={ui.pageHead}>
          <h2>模型</h2>
          <div className={ui.row}>
            <button
              type="button"
              className={ui.iconBtn}
              aria-label={creating ? "取消新增 provider" : "新增 provider"}
              title={creating ? "取消新增 provider" : "新增 provider"}
              aria-expanded={creating}
              onClick={() => setCreating((open) => !open)}
            >
              <PlusIcon />
            </button>
            <button
              type="button"
              className={ui.iconBtn}
              aria-label="重新读取"
              title="重新读取 models.json"
              onClick={refresh}
            >
              <RefreshIcon />
            </button>
          </div>
        </div>
        {error ? <p className={ui.error}>{error}</p> : null}

        <div className={ui.cardList}>
          {providers.length === 0 ? (
            <div className={`${ui.card} ${ui.empty}`}>还没有接入模型服务，点右上角的 + 添加一个。</div>
          ) : null}
          {providers.map((provider) => (
            <ProviderCard
              key={provider.id}
              provider={provider}
              onError={setError}
              onOpen={() => setDetailsId(provider.id)}
            />
          ))}

          {creating ? (
            <form
              className={ui.card}
              onSubmit={async (event) => {
                event.preventDefault();
                const form = event.currentTarget;
                const data = new FormData(form);
                const id = String(data.get("id") ?? "").trim();
                const saved = await run(() =>
                  getModel().saveProvider(id, {
                    baseUrl: String(data.get("baseUrl") ?? "").trim(),
                    api: String(data.get("api") ?? "").trim(),
                    apiKey: String(data.get("apiKey") ?? ""),
                  }),
                );
                if (saved) {
                  form.reset();
                  setCreating(false);
                  setDetailsId(id);
                }
              }}
            >
              <div className={ui.cardHead}>
                <span className={ui.cardTitle}>新增 provider</span>
                <span className={ui.spacer} />
                <button type="submit" className={`${ui.btn} ${ui.primary}`}>
                  保存
                </button>
              </div>
              <div className={ui.row}>
                <label className={ui.field}>
                  <span>id</span>
                  <input className={ui.fieldInput} name="id" placeholder="my-gateway" required />
                </label>
                <label className={`${ui.field} ${ui.wide}`}>
                  <span>baseUrl</span>
                  <input className={ui.fieldInput} name="baseUrl" placeholder="https://host/v1" required />
                </label>
                <label className={ui.field}>
                  <span>api</span>
                  <input className={ui.fieldInput} name="api" placeholder="openai-completions" />
                </label>
                <label className={ui.field}>
                  <span>apiKey</span>
                  <input
                    className={ui.fieldInput}
                    name="apiKey"
                    type="password"
                    placeholder="留空表示保持不变"
                  />
                </label>
              </div>
            </form>
          ) : null}
        </div>
      </div>
      {detailProvider ? (
        <ProviderDetails provider={detailProvider} onClose={() => setDetailsId(null)} />
      ) : null}
    </section>
  );
}
