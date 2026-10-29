import { useDialog } from "../store/dialog";
import { useModel } from "../store/model";
import { useProbe } from "../store/probe";
import { useRunConfig } from "../store/run-config";
import { useSession } from "../store/session";
import { useSkill } from "../store/skill";
import { useTranscript } from "../store/transcript";

/**
 * Every test starts from empty stores. The stores carry no test-only API: their
 * state is reachable through zustand's own `setState`.
 */
export function resetStores(): void {
  useSession.setState({ list: [], loading: false });
  useTranscript.setState({ items: new Map(), busy: new Map() });
  useDialog.setState({ queue: new Map() });
  useModel.setState({
    providers: [],
    available: [],
    defaultModel: null,
    defaultThinkingLevel: "",
    loaded: false,
  });
  useSkill.setState({ list: [], loading: false });
  useProbe.setState({ results: new Map(), running: new Set(), current: new Set() });
  useRunConfig.setState({
    chosen: new Map(),
    thinking: new Map(),
    workspace: new Map(),
  });
}
