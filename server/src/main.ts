import { createApp } from './app.ts';
// Existing AI/telephone keys and mode flags are deliberately never loaded or read.
const port = Number(process.env.ON_PORT ?? process.env.PORT ?? 8090);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('유효한 서버 포트가 필요합니다.');
const { app } = await createApp();
await app.listen({ host: '127.0.0.1', port });
console.log(`온 마을 로컬 시뮬레이션: http://localhost:${port} · 외부 호출 없음`);
process.on('SIGINT', () => void app.close());
process.on('SIGTERM', () => void app.close());
