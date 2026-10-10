import Fastify from 'fastify';
import serve from '@fastify/static';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ShowcaseRuntime } from '../../shared/src/showcase.ts';
import { DomainError } from '../../shared/src/runtime.ts';
import { SimulationClock, type SimulationClockOptions } from './simulation.ts';

/** Demo-only entrypoint: intentionally has no provider, credentials, webhook or persistence adapter. */
export async function createApp(
  options: { seed?: number; simulation?: SimulationClockOptions } = {},
) {
  const app = Fastify({ logger: false, bodyLimit: 16 * 1024 });
  const runtime = new ShowcaseRuntime(options.seed);
  const instance = randomUUID();
  let queue = Promise.resolve();
  const serialized = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work);
    queue = next.then(
      () => {},
      () => {},
    );
    return next;
  };
  const simulation = new SimulationClock(
    () => runtime.view(),
    async (delta) => {
      runtime.tickCycle(delta);
    },
    serialized,
    options.simulation,
  );
  app.addHook('onRequest', async (_request, reply) => {
    reply.header('x-onmaul-instance', instance);
    reply.header('Cache-Control', 'no-store');
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; media-src 'none'; object-src 'none'; frame-src 'none'",
    );
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof DomainError)
      return reply.code(error.status).send({ error: error.message, code: error.code });
    if (error instanceof z.ZodError)
      return reply.code(400).send({ error: '요청 형식을 확인해 주세요.' });
    reply.code(500).send({ error: '모의 재생 처리 오류' });
  });
  app.get('/api/health', async () => ({
    ok: true,
    mode: 'demo',
    executionMode: 'local-rules',
    externalCalls: false,
    phoneEnabled: false,
    scenarioCount: runtime.view().showcase!.catalog.length,
  }));
  app.get('/api/state', async () => runtime.view());
  app.get('/api/export', async () => runtime.view());
  app.post('/api/command', async (_request, reply) =>
    reply.code(403).send({
      code: 'read_only_playback',
      error: '관람 전용 시뮬레이션입니다. 재생 상태를 변경할 수 없습니다.',
    }),
  );
  // Old deployments must not accidentally expose live dialing, token bootstrap or audio sockets.
  app.addHook('preHandler', async (request, reply) => {
    if (
      /^\/(?:api\/(?:phone|telephony|telnyx|config|voice|disaster)|webhooks|media|probe|voice)(?:\/|$)/.test(
        request.url.split('?')[0],
      )
    )
      return reply
        .code(410)
        .send({ error: '외부 전화·AI 기능이 제거되었습니다. 로컬 모의 재생만 제공합니다.' });
  });
  const dist = fileURLToPath(new URL('../../fe/dist/', import.meta.url));
  if (existsSync(dist)) await app.register(serve, { root: dist, prefix: '/' });
  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith('/api/') || !existsSync(dist))
      return reply.code(404).send({ error: '없는 경로입니다.' });
    return reply.sendFile('index.html');
  });
  app.addHook('onClose', async () => {
    simulation.close();
    await queue;
  });
  return { app, runtime, simulation };
}
