/** The line model the transcript renders. */
import type { PromptImage } from "../lib/agent";

export type Item =
  | { id: number; kind: "user"; text: string; images?: PromptImage[] }
  | { id: number; kind: "assistant"; text: string }
  | { id: number; kind: "thinking"; text: string }
  | {
      id: number;
      kind: "tool";
      callId?: string;
      name: string;
      summary?: string;
      text?: string;
      isError?: boolean;
      durationMs?: number;
      running: boolean;
    }
  | { id: number; kind: "notice"; text: string; error?: boolean };

let seq = 0;
export const nextItemId = () => ++seq;
