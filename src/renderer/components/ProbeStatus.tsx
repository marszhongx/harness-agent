import type { ModelProbe } from "../lib/agent";
import ui from "../styles/ui.module.css";
import { CheckIcon, LoadingIcon, WarningIcon } from "./Icons";
import Tag from "./Tag";

/** Icon-only status for a model probe: loading, success, or failure + tooltip. */
export default function ProbeStatus({ result, loading }: { result: ModelProbe | null; loading: boolean }) {
  if (loading) {
    return (
      <Tag className={ui.probeTag} role="status" aria-label="测试中" title="测试中">
        <span className={ui.probeSpinner}>
          <LoadingIcon size={12} />
        </span>
      </Tag>
    );
  }
  if (!result) return null;
  return (
    <Tag
      tone={result.ok ? "ok" : "error"}
      className={ui.probeTag}
      role="status"
      aria-label={result.ok ? "可用" : "失败"}
      title={result.ok ? "可用" : (result.error ?? "失败")}
    >
      {result.ok ? <CheckIcon size={12} /> : <WarningIcon size={12} />}
    </Tag>
  );
}
