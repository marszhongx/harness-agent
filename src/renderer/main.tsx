import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles/tokens.css";
import "./styles/base.css";
import { useRunConfig } from "./store/run-config";
import { useSessions } from "./store/sessions";
import { useTranscripts } from "./store/transcript";

const container = document.getElementById("root");
if (!container) throw new Error("#root is missing from index.html");

if (import.meta.env.DEV) {
  // Dev-only handle for screenshots: a state can be installed before a capture
  // instead of clicking through the app to reach it.
  (window as unknown as { __harness: unknown }).__harness = {
    useTranscripts,
    useSessions,
    useRunConfig,
  };
}

createRoot(container).render(<App />);
