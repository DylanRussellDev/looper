import { defineConfig } from '@playwright/test';

const PORT = 4300;

export default defineConfig({
  testDir: './e2e',
  // The audio clock keeps running in real time, so parallel browsers competing for CPU
  // would make the timing assertions flaky.
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chrome',
      use: {
        // The installed Chrome, so no browser download is needed.
        channel: 'chrome',
        launchOptions: {
          args: [
            // Auto-accept the microphone prompt.
            '--use-fake-ui-for-media-stream',
            // Replace real inputs with a fake device that plays a steady beep.
            '--use-fake-device-for-media-stream',
            '--autoplay-policy=no-user-gesture-required',
          ],
        },
      },
    },
  ],
  webServer: {
    command: `npx ng serve --port ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
