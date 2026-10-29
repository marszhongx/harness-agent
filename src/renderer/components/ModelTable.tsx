import { useEffect, useRef, useState } from "react";
import type { ProviderSummary } from "../lib/agent";
import { getModel } from "../store/model";
import { getProbe, probeKey, useProbe } from "../store/probe";
import ui from "../styles/ui.module.css";
import { CheckIcon, CloseIcon, PlusIcon, TestIcon, TrashIcon } from "./Icons";
import ProbeStatus from "./ProbeStatus";

interface PendingModel {
  key: number;
  id: string;
  name: string;
  contextWindow: string;
}

/** Saved models plus the pending rows of one provider, in one table. */
export default function ModelTable({
  provider,
  onError,
}: {
  provider: ProviderSummary;
  onError: (message: string | null) => void;
}) {
  const results = useProbe((state) => state.results);
  const running = useProbe((state) => state.running);
  const current = useProbe((state) => state.current);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<PendingModel[]>([]);
  const pendingSeq = useRef(0);
  const pendingEnd = useRef<HTMLTableRowElement>(null);
  const pendingCount = useRef(0);

  const selectedModels = provider.models.filter((model) => selected.has(model.id));
  const allSelected = provider.models.length > 0 && selectedModels.length === provider.models.length;
  const runningSelected = selectedModels.some((model) => running.has(probeKey(provider.id, model.id)));
  // The table is the saved models plus the rows still being added.
  const rows: Array<
    { kind: "saved"; model: ProviderSummary["models"][number] } | { kind: "pending"; draft: PendingModel }
  > = [
    ...provider.models.map((model) => ({ kind: "saved" as const, model })),
    ...pending.map((draft) => ({ kind: "pending" as const, draft })),
  ];

  // A new row goes below the table; make sure the dialog scrolls to it.
  useEffect(() => {
    if (pending.length > pendingCount.current) {
      pendingEnd.current?.scrollIntoView?.({ block: "nearest" });
    }
    pendingCount.current = pending.length;
  }, [pending.length]);

  const failure = (cause: unknown) => onError(cause instanceof Error ? cause.message : String(cause));

  const toggleModel = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(provider.models.map((model) => model.id)));
  };

  const testSelected = () => {
    if (runningSelected || selectedModels.length === 0) return;
    void getProbe().run(
      provider.id,
      selectedModels.map((model) => model.id),
    );
  };

  const removeModel = async (modelId: string) => {
    onError(null);
    try {
      await getModel().removeModel(provider.id, modelId);
      getProbe().forgetModel(provider.id, modelId);
    } catch (cause) {
      failure(cause);
    }
  };

  const addPending = () => {
    pendingSeq.current += 1;
    setPending((rows) => [...rows, { key: pendingSeq.current, id: "", name: "", contextWindow: "" }]);
  };

  const updatePending = (key: number, patch: Partial<Omit<PendingModel, "key">>) => {
    setPending((rows) => rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  };

  const removePending = (key: number) => {
    setPending((rows) => rows.filter((row) => row.key !== key));
  };

  const savePending = async (draft: PendingModel) => {
    const id = draft.id.trim();
    if (!id) return;
    const size = Number(draft.contextWindow.replace(/[^0-9]/g, ""));
    onError(null);
    try {
      await getModel().addModel(provider.id, {
        id,
        name: draft.name.trim() || undefined,
        contextWindow: size || undefined,
      });
      // The saved model comes back from the store; the pending row leaves.
      removePending(draft.key);
    } catch (cause) {
      failure(cause);
    }
  };

  return (
    <>
      <div className={ui.modelSectionHead}>
        <span className={ui.modelSectionTitle}>模型管理</span>
        <span className={ui.cardSub}>
          {selectedModels.length} 个已选
          {pending.length > 0 ? ` · ${pending.length} 个待添加` : ""}
        </span>
        <span className={ui.spacer} />
        <button
          type="button"
          className={ui.iconBtn}
          aria-label="测试选中的模型"
          title="测试选中的模型"
          disabled={runningSelected || selectedModels.length === 0}
          onClick={testSelected}
        >
          <TestIcon />
        </button>
        <button
          type="button"
          className={ui.iconBtn}
          aria-label="添加模型"
          title="添加模型"
          onClick={addPending}
        >
          <PlusIcon />
        </button>
      </div>

      <table className={ui.modelTable}>
        <thead>
          <tr>
            <th className={ui.modelCheck}>
              <input
                type="checkbox"
                aria-label="全选模型"
                checked={allSelected}
                disabled={provider.models.length === 0}
                onChange={toggleAll}
              />
            </th>
            <th>模型</th>
            <th className={ui.modelCtx}>上下文</th>
            <th className={ui.modelActions} aria-label="操作" />
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={4} className={ui.empty}>
                还没有模型
              </td>
            </tr>
          ) : null}
          {rows.map((row) => {
            if (row.kind === "saved") {
              const { model } = row;
              const key = probeKey(provider.id, model.id);
              return (
                <tr key={model.id}>
                  <td className={ui.modelCheck}>
                    <input
                      type="checkbox"
                      aria-label={`选择模型 ${model.id}`}
                      checked={selected.has(model.id)}
                      disabled={running.has(key)}
                      onChange={() => toggleModel(model.id)}
                    />
                  </td>
                  <td
                    className={ui.modelNameCell}
                    title={model.name && model.name !== model.id ? `${model.name} · ${model.id}` : model.id}
                  >
                    <div className={ui.modelNameRow}>
                      <span className={ui.modelId}>{model.id}</span>
                      <ProbeStatus result={results.get(key) ?? null} loading={current.has(key)} />
                    </div>
                    {model.name && model.name !== model.id ? (
                      <span className={ui.modelName}>{model.name}</span>
                    ) : null}
                  </td>
                  <td className={ui.modelCtx}>
                    {model.contextWindow ? `${Math.round(model.contextWindow / 1024)}k` : "—"}
                  </td>
                  <td className={ui.modelActions}>
                    <button
                      type="button"
                      className={`${ui.iconBtn} ${ui.danger}`}
                      aria-label={`移除模型 ${model.id}`}
                      title="移除模型"
                      onClick={() => void removeModel(model.id)}
                    >
                      <TrashIcon />
                    </button>
                  </td>
                </tr>
              );
            }

            const { draft } = row;
            return (
              <tr
                key={`pending-${draft.key}`}
                ref={draft.key === pending.at(-1)?.key ? pendingEnd : undefined}
                className={ui.modelAddRow}
              >
                <td className={ui.modelCheck} />
                <td className={ui.modelNameCell}>
                  <div className={ui.modelAddFields}>
                    <input
                      className={ui.fieldInput}
                      aria-label="新模型 id"
                      placeholder="模型 id"
                      value={draft.id}
                      onChange={(event) => updatePending(draft.key, { id: event.currentTarget.value })}
                    />
                    <input
                      className={ui.fieldInput}
                      aria-label="新模型显示名"
                      placeholder="显示名（可选）"
                      value={draft.name}
                      onChange={(event) => updatePending(draft.key, { name: event.currentTarget.value })}
                    />
                  </div>
                </td>
                <td className={ui.modelCtx}>
                  <input
                    className={ui.fieldInput}
                    aria-label="新模型上下文"
                    placeholder="131072"
                    value={draft.contextWindow}
                    onChange={(event) =>
                      updatePending(draft.key, { contextWindow: event.currentTarget.value })
                    }
                  />
                </td>
                <td className={ui.modelActions}>
                  <button
                    type="button"
                    className={ui.iconBtn}
                    aria-label="保存新模型"
                    title="保存"
                    disabled={!draft.id.trim()}
                    onClick={() => void savePending(draft)}
                  >
                    <CheckIcon />
                  </button>
                  <button
                    type="button"
                    className={ui.iconBtn}
                    aria-label="取消新模型"
                    title="取消"
                    onClick={() => removePending(draft.key)}
                  >
                    <CloseIcon />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}
