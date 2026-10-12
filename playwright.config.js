// Browser tests for the page. Run with `npm run test:e2e` (installs nothing global;
// run `npx playwright install chromium` once first).
const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: 'test/e2e',
  // One worker: Python's built-in server only queues 5 pending connections, and the
  // suite takes a few seconds anyway.
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    // Dates are computed in local time; pin the zone and locale so assertions are stable.
    timezoneId: 'America/Los_Angeles',
    locale: 'en-US',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'python3 -m http.server 4173 --bind 127.0.0.1',
    url: 'http://127.0.0.1:4173/index.html',
    reuseExistingServer: !process.env.CI,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
