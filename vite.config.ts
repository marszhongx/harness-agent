import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Renderer-only build. The main and preload processes are not bundled: they run
 * as TypeScript directly in Electron's Node, so the only thing that needs a
 * compiler here is JSX plus the npm imports React drags in.
 */
export default defineConfig({
  root: "src/renderer",
  // Relative URLs: the packaged window loads the build over `app://bundle/`,
  // where absolute paths would escape the served directory.
  base: "./",
  plugins: [react()],
  css: {
    // Class names stay kebab-case in CSS; components read them as styles.toolCard.
    modules: { localsConvention: "camelCaseOnly" },
  },
  build: { outDir: "dist", emptyOutDir: true },
  // Bind IPv4 explicitly: Vite's default `localhost` can resolve to ::1 while
  // the Electron window dials 127.0.0.1, which shows up as ERR_CONNECTION_REFUSED.
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
});
