import { useCallback, useEffect, useState } from "react";
import { PlusIcon, RefreshIcon, TrashIcon } from "../components/Icons";
import { agent, type ProviderSummary } from "../lib/agent";
import ui from "../styles/ui.module.css";

/**
 * `models.json` is pi's file, so this page edits it rather than keeping its own
 * copy: every change is written back and followed by a worker restart.
 *
 * Providers are peers in one divided panel; the two forms are folded away until
 * asked for, because they are used far less often than reading the list.
 */
export default function ModelsPage() {
  const [providers, setProviders] = useState<ProviderSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setProviders(await agent().modelsList());
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (action: () => Promise<ProviderSummary[]>) => {
    setError(null);
    try {
      setProviders(await action());
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    }
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
              onClick={() => void load()}
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
            <ProviderRow key={provider.id} provider={provider} onChanged={setProviders} onError={setError} />
          ))}

          {creating ? (
            <form
              className={ui.card}
              onSubmit={async (event) => {
                event.preventDefault();
                const form = event.currentTarget;
                const data = new FormData(form);
                const saved = await run(() =>
                  agent().saveProvider(String(data.get("id") ?? "").trim(), {
                    baseUrl: String(data.get("baseUrl") ?? "").trim(),
                    api: String(data.get("api") ?? "").trim(),
                    apiKey: String(data.get("apiKey") ?? ""),
                  }),
                );
                if (saved) {
                  form.reset();
                  setCreating(false);
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
    </section>
  );
}

function ProviderRow({
  provider,
  onChanged,
  onError,
}: {
  provider: ProviderSummary;
  onChanged: (next: ProviderSummary[]) => void;
  onError: (message: string | null) => void;
}) {
  const [armed, setArmed] = useState(false);
  const [adding, setAdding] = useState(false);

  const remove = async () => {
    if (!armed) {
      setArmed(true);
      setTimeout(() => setArmed(false), 4000);
      return;
    }
    onError(null);
    try {
      onChanged(await agent().removeProvider(provider.id));
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <div className={ui.card}>
      <div className={ui.cardHead}>
        <span className={ui.cardTitle}>{provider.id}</span>
        <span className={`${ui.badge} ${provider.hasKey ? ui.ok : ui.warn}`}>
          {provider.hasKey ? "已配置" : "未配置密钥"}
        </span>
        <span className={ui.badge}>{provider.models.length} 个模型</span>
        <span className={ui.spacer} />
        <button
          type="button"
          className={ui.iconBtn}
          aria-label={adding ? `取消给 ${provider.id} 添加模型` : `给 ${provider.id} 添加模型`}
          title={adding ? "取消" : "添加模型"}
          aria-expanded={adding}
          onClick={() => setAdding((open) => !open)}
        >
          <PlusIcon />
        </button>
        <button
          type="button"
          className={`${ui.iconBtn} ${ui.danger}`}
          aria-label={armed ? `确认删除 ${provider.id}` : `删除 ${provider.id}`}
          title={armed ? "再点一次确认删除" : "删除"}
          onClick={() => void remove()}
        >
          {armed ? <span className={ui.confirmDot}>?</span> : <TrashIcon />}
        </button>
      </div>
      <div className={ui.path} title={provider.baseUrl}>
        {provider.baseUrl || "（未设 baseUrl）"}
      </div>

      <div className={ui.modelChips}>
        {provider.models.length === 0 ? <span className={ui.empty}>还没有模型</span> : null}
        {provider.models.map((model) => (
          <span className={ui.modelChip} key={model.id}>
            <span>{model.id}</span>
            {model.contextWindow ? (
              <span className={ui.modelCtx}>{Math.round(model.contextWindow / 1024)}k</span>
            ) : null}
            <button
              type="button"
              className={ui.btn}
              title="移除这个模型"
              onClick={() => {
                void agent()
                  .removeModel(provider.id, model.id)
                  .then(onChanged)
                  .catch((cause: unknown) => onError(cause instanceof Error ? cause.message : String(cause)));
              }}
            >
              ×
            </button>
          </span>
        ))}
      </div>

      {adding ? (
        <form
          className={ui.inlineForm}
          onSubmit={async (event) => {
            event.preventDefault();
            const form = event.currentTarget;
            const data = new FormData(form);
            const size = Number(String(data.get("contextWindow") ?? "").replace(/[^0-9]/g, ""));
            onError(null);
            try {
              onChanged(
                await agent().addModel(provider.id, {
                  id: String(data.get("id") ?? "").trim(),
                  name: String(data.get("name") ?? "").trim() || undefined,
                  contextWindow: size || undefined,
                }),
              );
              form.reset();
              setAdding(false);
            } catch (cause) {
              onError(cause instanceof Error ? cause.message : String(cause));
            }
          }}
        >
          <label className={ui.field}>
            <span>id</span>
            <input className={ui.fieldInput} name="id" placeholder="模型 id" required />
          </label>
          <label className={ui.field}>
            <span>name</span>
            <input className={ui.fieldInput} name="name" placeholder="显示名（可选）" />
          </label>
          <label className={ui.field}>
            <span>contextWindow</span>
            <input className={ui.fieldInput} name="contextWindow" placeholder="例如 131072" />
          </label>
          <button type="submit" className={`${ui.btn} ${ui.primary}`}>
            添加
          </button>
        </form>
      ) : null}
    </div>
  );
}
