import { defineConfig } from "vitest/config";

/**
 * Two kinds of tests live side by side:
 *   - `src/host/*.test.ts`      plain Node, no DOM, no electron
 *   - component tests under src/renderer  happy-dom + Testing Library
 * The environment is picked per file with a `@vitest-environment` docblock.
 * CSS Modules stay hashed, so tests query by role, label, test id or text rather
 * than by class name.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    setupFiles: ["src/renderer/test/setup.ts"],
    reporters: ["dot"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
      reportsDirectory: "coverage",
      // Only the parts a unit test can reach. `src/main` and `src/preload` need a
      // running Electron app; the smoke scripts cover those paths instead.
      include: ["src/host/**/*.ts", "src/renderer/**/*.ts", "src/renderer/**/*.tsx"],
      // Floors, not targets: they sit just under today's numbers so a change that
      // silently drops coverage fails instead of passing quietly.
      thresholds: { statements: 86, branches: 74, functions: 84, lines: 89 },
      exclude: [
        "src/**/*.test.ts",
        "src/**/*.test.tsx",
        "src/host/protocol.ts",
        "src/host/pi-transport.ts",
        "src/host/agent-host.ts",
        "src/host/worker.ts",
        "src/renderer/main.tsx",
        "src/renderer/lib/agent.ts",
        "src/renderer/test/**",
      ],
    },
  },
});
