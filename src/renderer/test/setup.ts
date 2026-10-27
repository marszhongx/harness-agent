import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Testing Library mounts into the document; without this every test leaves its
// tree behind and queries hit the previous component.
afterEach(() => {
  cleanup();
});
