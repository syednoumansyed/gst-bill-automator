import path from "node:path";
import { defineConfig } from "vitest/config";

const alias = { "@": path.resolve(__dirname, "src") };

/**
 * Two projects:
 *  - unit:     fast, no browser. Everything under tests/** except *.chromium.test.ts.
 *  - chromium: renders real PDFs through Puppeteer. Skip with `npm run test:fast`.
 */
export default defineConfig({
  test: {
    // pdfjs warns about missing standard-font data for the Helvetica in synthetic PDFs; harmless noise
    onConsoleLog: (log) => (log.includes("standardFontDataUrl") ? false : undefined),
    projects: [
      {
        resolve: { alias },
        test: {
          name: "unit",
          environment: "node",
          include: ["tests/**/*.test.ts"],
          exclude: ["tests/**/*.chromium.test.ts", "node_modules/**"],
        },
      },
      {
        resolve: { alias },
        test: {
          name: "chromium",
          environment: "node",
          include: ["tests/**/*.chromium.test.ts"],
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
