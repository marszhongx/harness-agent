/**
 * Which thinking levels a model accepts.
 *
 * Same rule as pi (`getSupportedThinkingLevels` in pi-ai): a model that does not
 * reason only has `off`; the rest accept every level except `xhigh` and `max`,
 * which exist only when the model maps them explicitly, and any level mapped to
 * `null` is out. Computing it here means the menu is right before a worker has
 * ever started.
 */
import type { ModelInfo } from "./agent";

/** pi's whole vocabulary, in order. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function supportedThinkingLevels(model: ModelInfo | null | undefined): string[] {
  if (!model?.reasoning) return ["off"];
  return THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    return level === "xhigh" || level === "max" ? mapped !== undefined : true;
  });
}
