import { createApp } from './app.ts';
import { config } from './telephony.ts';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { loadEnvironment } from '../../src/runtime-env.ts';
import { ConfigStore } from '../../src/config.ts';
const root = fileURLToPath(new URL('../../', import.meta.url));
loadEnvironment(root);
const phoneEnabled =
  process.env.ON_EXECUTION_MODE === 'hybrid' &&
  /^(?:yes|true|1)$/i.test(process.env.ON_PHONE_ENABLED ?? '');
const store = phoneEnabled
  ? new ConfigStore(resolve(root, process.env.ON_LOCAL_DATA_DIR || '.data'))
  : undefined;
const environment = { ...process.env };
if (store)
  for (const [key, value] of Object.entries(store.value))
    if (!environment[key]?.trim()) environment[key] = String(value);
const settings = config(environment);
const { app } = await createApp({
  settings,
  journal: resolve(root, process.env.ON_JOURNAL_DIR ?? '.data/mock'),
  phoneOptions: { root, store, environment },
});
await app.listen({ host: '127.0.0.1', port: settings.port });
console.log(
  `온 마을 React 상황실: http://localhost:${settings.port} · ${settings.mode} · LangGraph 규칙 경로`,
);
process.on('SIGINT', () => void app.close());
process.on('SIGTERM', () => void app.close());
