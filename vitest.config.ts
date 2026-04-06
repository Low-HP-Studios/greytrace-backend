import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**"],
    environment: "edge-runtime",
    server: {
      deps: {
        inline: ["convex-test"],
      },
    },
  },
});
