import path from "node:path";
import { defineConfig } from "vitest/config";

const alias = { "@": path.resolve(__dirname, "src") };

/**
 * Four projects (`npm test` runs unit + chromium only):
 *  - unit:       fast, no browser. Everything under tests/** except chromium and regression tests.
 *  - chromium:   renders real PDFs through Puppeteer. Skip with `npm run test:fast`.
 *  - regression: layout-mutation corpus (synthetic). Needs the extraction engine. `npm run test:regression`.
 *  - private:    golden run over real documents in fixtures-private/; skips itself when that folder is absent.
 *                `npm run test:private`.
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
          exclude: ["tests/**/*.chromium.test.ts", "tests/regression/**", "node_modules/**"],
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
      {
        resolve: { alias },
        test: {
          name: "regression",
          environment: "node",
          include: ["tests/regression/**/*.test.ts"],
          exclude: ["tests/regression/private/**", "node_modules/**"],
          testTimeout: 30_000,
        },
      },
      {
        resolve: { alias },
        test: {
          name: "private",
          environment: "node",
          include: ["tests/regression/private/**/*.test.ts"],
          testTimeout: 60_000,
        },
      },
    ],
  },
});
