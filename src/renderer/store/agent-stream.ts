/**
 * Share one subscription to the agent event stream between components.
 *
 * The first component that needs a stream installs it, the last one to unmount
 * removes it. Mount and unmount in tests therefore leave nothing behind, which a
 * module-level "already subscribed" flag would not.
 */
import { useEffect } from "react";

const shared = new Map<() => () => void, { count: number; stop: (() => void) | null }>();

export function useAgentStream(start: () => () => void): void {
  useEffect(() => {
    let slot = shared.get(start);
    if (!slot) {
      slot = { count: 0, stop: null };
      shared.set(start, slot);
    }
    slot.count += 1;
    slot.stop ??= start();

    return () => {
      slot.count -= 1;
      if (slot.count === 0) {
        slot.stop?.();
        slot.stop = null;
      }
    };
  }, [start]);
}
