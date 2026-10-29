/**
 * The renderer's view of the preload bridge.
 *
 * The contract itself lives in `src/shared/contract.ts`; this module re-exports
 * its types so components keep importing from `lib/agent`, and adds the
 * renderer-only helpers that work on top of the bridge.
 */
import type { AgentApi } from "../../shared/contract.ts";

export type {
  AgentApi,
  AgentEvent,
  AgentStatus,
  DialogRequest,
  ModelInfo,
  ModelProbe,
  PromptImage,
  ProviderSummary,
  SessionSummary,
  SettingsSnapshot,
  SkillSummary,
  TranscriptItem,
  UiAnswer,
} from "../../shared/contract.ts";

declare global {
  interface Window {
    agent: AgentApi;
  }
}

export const agent = (): AgentApi => window.agent;

/** `2026-10-24T11-13-05-045Z...` or a plain timestamp, rendered for humans. */
export function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  const date = new Date(ms);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}
