import { useState } from "react";
import type { ProviderSummary } from "../lib/agent";
import { getModel } from "../store/model";
import { getProbe, probeKey, useProbe } from "../store/probe";
import ui from "../styles/ui.module.css";
import { TrashIcon } from "./Icons";
import ProbeStatus from "./ProbeStatus";
import Tag from "./Tag";

/** One provider on the Models page: summary, actions, and its saved models. */
export default function ProviderCard({
  provider,
  onOpen,
  onError,
}: {
  provider: ProviderSummary;
  onOpen: () => void;
  onError: (message: string | null) => void;
}) {
  const [armed, setArmed] = useState(false);
  const results = useProbe((state) => state.results);
  const current = useProbe((state) => state.current);

  const failure = (cause: unknown) => onError(cause instanceof Error ? cause.message : String(cause));

  const remove = async () => {
    if (!armed) {
      setArmed(true);
      setTimeout(() => setArmed(false), 4000);
      return;
    }
    onError(null);
    try {
      await getModel().removeProvider(provider.id);
      getProbe().forget(provider.id);
    } catch (cause) {
      failure(cause);
    }
  };

  return (
    <div className={ui.card}>
      <div className={ui.cardHead}>
        <span className={ui.cardTitle}>{provider.id}</span>
        <Tag>{provider.models.length} 个模型</Tag>
        <span className={ui.spacer} />
        <button type="button" className={ui.btn} onClick={onOpen}>
          详情
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
      <div className={ui.providerModels}>
        {provider.models.length === 0 ? <span className={ui.empty}>还没有模型</span> : null}
        {provider.models.map((model) => {
          const key = probeKey(provider.id, model.id);
          return (
            <span
              className={ui.providerModel}
              key={model.id}
              title={model.name && model.name !== model.id ? `${model.name} · ${model.id}` : model.id}
            >
              <span className={ui.providerModelId}>{model.id}</span>
              {model.contextWindow ? (
                <span className={ui.providerModelCtx}>{Math.round(model.contextWindow / 1024)}k</span>
              ) : null}
              <ProbeStatus result={results.get(key) ?? null} loading={current.has(key)} />
            </span>
          );
        })}
      </div>
    </div>
  );
}
