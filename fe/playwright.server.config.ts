import { defineConfig } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const journal = mkdtempSync(join(tmpdir(), 'onmaul-cycle-http-'));

export default defineConfig({
  testDir: './tests',
  testMatch: '**/showcase-server.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 75_000,
  reporter: 'list',
  outputDir: join(journal, 'browser-results'),
  use: {
    baseURL: 'http://127.0.0.1:8092',
    viewport: { width: 1600, height: 1000 },
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'server-chromium', use: { browserName: 'chromium' } }],
  webServer: {
    command: 'node --import tsx server/src/main.ts',
    cwd: root,
    env: {
      ON_PORT: '8092',
      ON_EXECUTION_MODE: 'hybrid',
      ON_PHONE_ENABLED: 'yes',
      OPENAI_API_KEY: 'unused-key',
      TELNYX_API_KEY: 'unused-key',
      ON_OPERATOR_TOKEN: 'unused-token',
      ON_JOURNAL_DIR: journal,
    },
    url: 'http://127.0.0.1:8092/api/health',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
