import { createApp } from './app.ts';
import { config } from './telephony.ts';
const settings = config();
const { app } = await createApp({ settings, journal: process.env.ON_JOURNAL_DIR ?? '.data/mock' });
await app.listen({ host: '127.0.0.1', port: settings.port });
console.log(
  `온 마을 React 상황실: http://localhost:${settings.port} · ${settings.mode} · LangGraph 규칙 경로`,
);
process.on('SIGINT', () => void app.close());
process.on('SIGTERM', () => void app.close());
