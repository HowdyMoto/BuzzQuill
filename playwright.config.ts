import { defineConfig } from '@playwright/test';

/**
 * Playwright config for the SVG import/round-trip corpus tests.
 *
 * The importer relies on real browser SVG behaviour (DOM parsing, `<use>`/filter
 * resolution, layout/getBBox, href sanitization), so these run in a real browser
 * against the actual dev-served app rather than a simulated DOM. The test drives
 * the app's DEV-only `window.state` global.
 *
 * Locally it uses the system Google Chrome (channel: 'chrome') so no browser
 * download is needed; in CI it uses Playwright's bundled Chromium (installed via
 * `npx playwright install chromium`), which is more reproducible on runners.
 * The large corpus must be present first: `npm run corpus:fetch`.
 */
const port = Number(process.env.BQ_TEST_PORT ?? 5180);
const baseURL = `http://localhost:${port}`;

export default defineConfig({
  testDir: './test',
  testIgnore: '**/unit/**',    // test/unit/* is the Vitest (browserless) layer
  fullyParallel: false,        // big files are memory-heavy; run serially
  workers: 1,
  timeout: 120_000,            // 79MB / 117k-element files take a few seconds each
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL,
    // System Chrome locally; bundled Chromium in CI.
    channel: process.env.CI ? undefined : 'chrome',
  },
  webServer: {
    command: `npm run dev -- --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 60_000,
    // Placeholder Google identifiers so the server Playwright starts has Drive
    // configured (commands registered, CSP opened) — test/drive.spec.ts stubs every
    // Google endpoint, so nothing real is ever called. A REUSED local server has
    // whatever .env.local says; the spec skips itself when Drive isn't there.
    env: {
      VITE_GOOGLE_CLIENT_ID: process.env.BQ_TEST_NO_DRIVE ? '' : '000000000000-playwright.apps.googleusercontent.com',
      VITE_GOOGLE_API_KEY: process.env.BQ_TEST_NO_DRIVE ? '' : 'playwright-placeholder-key',
    },
  },
});
