import { useRunConfig } from "../store/run-config";
import { useSessions } from "../store/sessions";
import { useTranscripts } from "../store/transcript";

/**
 * Every test starts from empty stores. The stores carry no test-only API: their
 * state is reachable through zustand's own `setState`.
 */
export function resetStores(): void {
  useSessions.setState({ list: [], loading: false });
  useTranscripts.setState({ items: new Map(), busy: new Map() });
  useRunConfig.setState({
    models: [],
    defaultModel: null,
    chosen: new Map(),
    thinking: new Map(),
    workspace: new Map(),
  });
}
