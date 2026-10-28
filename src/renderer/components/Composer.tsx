import { type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import { agent, type ModelInfo, type PromptImage } from "../lib/agent";
import { supportedThinkingLevels, THINKING_LEVELS } from "../lib/thinking";
import { getModel, useModel, useModelSync } from "../store/model";
import {
  getRunConfig,
  useCurrentModel,
  useCurrentThinking,
  useRunConfig,
  useRunConfigSync,
} from "../store/run-config";
import ui from "../styles/ui.module.css";
import { ChevronDownIcon, FolderIcon, PaperclipIcon, SendIcon, StopIcon, ThinkingIcon } from "./Icons";

const IMAGE_TYPES = "image/png,image/jpeg,image/webp,image/gif";

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("读取图片失败"));
    reader.readAsDataURL(file);
  });
}

interface ComposerProps {
  /** `null` on the new-conversation page: the id is minted with the first message. */
  sessionId: string | null;
  busy: boolean;
  onSend: (text: string, images?: PromptImage[]) => Promise<void>;
}

export default function Composer({ sessionId, busy, onSend }: ComposerProps) {
  const models = useModel((state) => state.available);
  const defaultModel = useModel((state) => state.defaultModel);
  const thinking = useCurrentThinking(sessionId);
  const workspacePath = useRunConfig((state) => state.getWorkspace(sessionId));
  const currentModel = useCurrentModel(sessionId);
  useRunConfigSync(sessionId);
  // The catalogue is global; the composer is one of the places that needs it.
  useModelSync();

  const { chooseModel, chooseThinking } = getRunConfig();

  const [text, setText] = useState("");
  const [images, setImages] = useState<Array<PromptImage & { id: number }>>([]);
  const imageSeq = useRef(0);
  const [menu, setMenu] = useState<"model" | "thinking" | null>(null);

  const textarea = useRef<HTMLTextAreaElement>(null);
  const modelChip = useRef<HTMLButtonElement>(null);
  const thinkingChip = useRef<HTMLButtonElement>(null);

  /** Grow the textarea with its content, up to the CSS max-height. */
  const resizeTextarea = (node: HTMLTextAreaElement | null) => {
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, 200)}px`;
  };

  const modelLabel =
    models.find(
      (entry) =>
        entry.id === currentModel?.id &&
        (currentModel.provider === null || entry.provider === currentModel.provider),
    )?.name ??
    currentModel?.id ??
    null;

  const submit = async () => {
    if (busy) {
      if (sessionId) void agent().abort(sessionId);
      return;
    }
    if (!currentModel) {
      setMenu("model");
      return;
    }
    const payload = images.map(({ data, mimeType }) => ({ data, mimeType }));
    const trimmed = text.trim() || (payload.length > 0 ? "（见附图）" : "");
    setText("");
    setImages([]);
    resizeTextarea(textarea.current);
    await onSend(trimmed, payload.length > 0 ? payload : undefined);
  };

  const attach = async (files: FileList | null) => {
    if (!files) return;
    const next: Array<PromptImage & { id: number }> = [];
    for (const file of Array.from(files)) {
      try {
        const dataUrl = await readAsDataUrl(file);
        const comma = dataUrl.indexOf(",");
        const meta = dataUrl.slice(5, comma).replace(";base64", "");
        next.push({
          id: ++imageSeq.current,
          data: dataUrl.slice(comma + 1),
          mimeType: meta || file.type || "image/png",
        });
      } catch (error) {
        console.error(error);
      }
    }
    setImages((current) => [...current, ...next]);
  };

  return (
    <div className={ui.composerWrap}>
      <form
        className={ui.composer}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {images.length > 0 ? (
          <div className={ui.attachments}>
            {images.map((image) => (
              <div className={ui.attachment} key={image.id}>
                <img src={`data:${image.mimeType};base64,${image.data}`} alt="待发送附件" />
                <button
                  type="button"
                  onClick={() => setImages((current) => current.filter((entry) => entry.id !== image.id))}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        ) : null}

        <textarea
          ref={(node) => {
            textarea.current = node;
            resizeTextarea(node);
          }}
          className={ui.textarea}
          rows={1}
          value={text}
          placeholder={currentModel ? "发消息…" : "先选一个模型"}
          onChange={(event) => {
            setText(event.currentTarget.value);
            resizeTextarea(event.currentTarget);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void submit();
            }
          }}
        />

        <div className={ui.composerBar}>
          <label className={ui.chip} title="添加图片">
            <input
              type="file"
              accept={IMAGE_TYPES}
              multiple
              hidden
              onChange={(event) => {
                void attach(event.currentTarget.files);
                event.currentTarget.value = "";
              }}
            />
            <PaperclipIcon size={15} />
          </label>

          <button
            ref={thinkingChip}
            data-testid="thinking-chip"
            type="button"
            className={ui.chip}
            aria-label={thinking.level ? `思考等级 ${thinking.level}` : "思考等级"}
            title="思考等级"
            onClick={() => setMenu(menu === "thinking" ? null : "thinking")}
          >
            <ThinkingIcon />
            {thinking.level ? <span>{thinking.level}</span> : null}
            <ChevronDownIcon size={14} />
          </button>

          <button
            ref={modelChip}
            data-testid="model-chip"
            type="button"
            className={`${ui.chip} ${currentModel ? "" : ui.unset}`}
            onClick={() => setMenu(menu === "model" ? null : "model")}
          >
            <span>{modelLabel ?? "未选择模型"}</span>
            <ChevronDownIcon size={14} />
          </button>

          <button
            type="submit"
            className={`${ui.send} ${busy ? ui.stop : ""}`}
            disabled={!busy && (!currentModel || (text.trim().length === 0 && images.length === 0))}
            aria-label="发送"
          >
            {busy ? <StopIcon size={14} /> : <SendIcon size={16} />}
          </button>
        </div>
      </form>

      {menu ? (
        <Popover
          testId={menu === "model" ? "model-menu" : "thinking-menu"}
          anchor={menu === "model" ? modelChip : thinkingChip}
          onClose={() => setMenu(null)}
        >
          {menu === "model" ? (
            <ModelList
              models={models}
              current={currentModel}
              defaultModel={defaultModel}
              onPick={(provider, id) => {
                chooseModel(sessionId, provider, id);
                setMenu(null);
              }}
              onDefault={async (provider, id) => {
                await getModel().setDefaultModel(provider, id);
              }}
            />
          ) : (
            <ThinkingList
              levels={levelsForModel(models, currentModel, thinking.levels)}
              current={thinking.level}
              onPick={(level) => {
                chooseThinking(sessionId, level);
                setMenu(null);
              }}
            />
          )}
        </Popover>
      ) : null}

      <div className={ui.statusbar}>
        <WorkspaceChip sessionId={sessionId} workspacePath={workspacePath} />
      </div>
    </div>
  );
}

function ModelList({
  models,
  current,
  defaultModel,
  onPick,
  onDefault,
}: {
  models: Array<{ provider: string; id: string; name: string; contextWindow?: number }>;
  current: { provider: string; id: string } | null;
  defaultModel: { provider: string; id: string } | null;
  onPick: (provider: string, id: string) => void;
  onDefault: (provider: string, id: string) => Promise<void>;
}) {
  if (models.length === 0) return <div className={ui.modelGroup}>没有可用模型</div>;

  const groups = new Map<string, typeof models>();
  for (const model of models) {
    groups.set(model.provider, [...(groups.get(model.provider) ?? []), model]);
  }

  return (
    <>
      {[...groups].map(([provider, list]) => (
        <div key={provider}>
          <div className={ui.modelGroup}>{provider}</div>
          {list.map((model) => {
            const isDefault = defaultModel?.provider === model.provider && defaultModel.id === model.id;
            const isCurrent = current?.provider === model.provider && current.id === model.id;
            return (
              <div
                key={`${model.provider}/${model.id}`}
                className={`${ui.modelItem} ${isCurrent ? ui.current : ""}`}
              >
                <button
                  type="button"
                  className={ui.modelPick}
                  onClick={() => onPick(model.provider, model.id)}
                >
                  <span className={ui.name}>{model.name}</span>
                  {model.contextWindow ? (
                    <span className={ui.ctx}>{Math.round(model.contextWindow / 1024)}k</span>
                  ) : null}
                </button>
                <button
                  type="button"
                  className={`${ui.star} ${isDefault ? ui.set : ""}`}
                  title={isDefault ? "已是默认模型" : "设为默认模型"}
                  onClick={() => void onDefault(model.provider, model.id)}
                >
                  {isDefault ? "★" : "☆"}
                </button>
              </div>
            );
          })}
        </div>
      ))}
    </>
  );
}

/**
 * The catalogue knows which levels a model takes, so the menu is complete before
 * any conversation has run; the worker's report wins when the model is unknown
 * here (it came from somewhere else).
 */
function levelsForModel(
  models: ModelInfo[],
  model: { provider: string; id: string } | null,
  reported: string[],
): string[] {
  const entry = model
    ? models.find((item) => item.provider === model.provider && item.id === model.id)
    : undefined;
  if (entry) return supportedThinkingLevels(entry);
  return reported;
}

function ThinkingList({
  levels,
  current,
  onPick,
}: {
  levels: string[];
  current: string | null;
  onPick: (level: string) => void;
}) {
  return (
    <>
      <div className={ui.modelGroup}>思考等级</div>
      {THINKING_LEVELS.map((level) => {
        const disabled = levels.length > 0 && !levels.includes(level);
        return (
          <button
            key={level}
            type="button"
            className={`${ui.modelItem} ${level === current ? ui.current : ""}`}
            disabled={disabled}
            title={disabled ? "这个模型不支持" : undefined}
            onClick={() => onPick(level)}
          >
            <span className={ui.name}>{level}</span>
          </button>
        );
      })}
    </>
  );
}

function Popover({
  testId,
  anchor,
  onClose,
  children,
}: {
  testId: string;
  anchor: RefObject<HTMLElement | null>;
  onClose: () => void;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; bottom: number } | null>(null);
  // Callers pass a fresh arrow each render; keeping it in a ref keeps the
  // document listener installed once instead of on every render.
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const rect = anchor.current?.getBoundingClientRect();
    const width = box.current?.offsetWidth ?? 240;
    if (rect) {
      setPosition({
        left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 12)),
        bottom: window.innerHeight - rect.top + 8,
      });
    }
    const onDocumentClick = (event: MouseEvent) => {
      const target = event.target as Node;
      if (box.current?.contains(target)) return;
      if (anchor.current?.contains(target)) return;
      close.current();
    };
    document.addEventListener("click", onDocumentClick);
    return () => document.removeEventListener("click", onDocumentClick);
  }, [anchor]);

  return (
    <div
      ref={box}
      data-testid={testId}
      className={ui.modelMenu}
      style={position ? { left: position.left, bottom: position.bottom } : { visibility: "hidden" }}
    >
      {children}
    </div>
  );
}

/**
 * Which folder the conversation works in.
 *
 * Before the first message it is still a choice: clicking opens a folder picker.
 * Once the conversation exists pi has opened it there, so the chip only reveals
 * the folder instead of pretending it can be moved.
 */
function WorkspaceChip({
  sessionId,
  workspacePath,
}: {
  sessionId: string | null;
  workspacePath: string | null;
}) {
  if (!workspacePath) return <span className={ui.workspace}>…</span>;
  const name = workspacePath.split("/").filter(Boolean).at(-1) ?? workspacePath;
  const draft = sessionId === null;
  return (
    <button
      type="button"
      className={ui.workspace}
      title={
        draft ? `这个对话使用的工作目录，点击更改：${workspacePath}` : `工作目录（已固定）：${workspacePath}`
      }
      onClick={() => {
        if (draft) {
          void agent()
            .chooseDraftWorkspace()
            .then(() => getRunConfig().sync(null));
          return;
        }
        void agent().revealPath(workspacePath);
      }}
    >
      <FolderIcon size={13} />
      <span>{name}</span>
    </button>
  );
}
