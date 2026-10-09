import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createServer, request } from 'node:http';
import { generateKeyPairSync, sign } from 'node:crypto';
import WebSocket from 'ws';
import { createApplication } from '../src/server.ts';
import { verifyWebhook } from '../src/callbacks.ts';
import { FakeSocket, flush } from './helpers.ts';
async function port() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const value = (server.address() as any).port;
  await new Promise<void>((r) => server.close(() => r()));
  return value;
}
test('Ed25519 원문·변조·타임스탬프 ±5분 경계', () => {
  const keys = generateKeyPairSync('ed25519'),
    key = keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64'),
    raw = Buffer.from('{"data":{"id":"event-test"}}'),
    timestamp = '1791500000';
  const headers = {
    'telnyx-timestamp': timestamp,
    'telnyx-signature-ed25519': sign(
      null,
      Buffer.concat([Buffer.from(timestamp + '|'), raw]),
      keys.privateKey,
    ).toString('base64'),
  };
  assert.equal(verifyWebhook(raw, headers, key, 1791500000000 + 300000), true);
  assert.equal(verifyWebhook(raw, headers, key, 1791500000000 + 300001), false);
  assert.equal(verifyWebhook(raw, headers, key, 1791500000000 - 300001), false);
  assert.equal(verifyWebhook(Buffer.from('{}'), headers, key, 1791500000000), false);
});
test('로컬 Host·Origin·cross-site·CSRF, 공개 설정 차단, 실제 외부 요청 없는 HTTP 통합', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'on-http-')),
    ui = await port(),
    callback = await port();
  let external = 0;
  const app = createApplication(process.cwd(), {
    env: { PORT: String(ui), CALLBACK_PORT: String(callback), ON_LOCAL_DATA_DIR: dir },
    fetcher: async () => {
      external++;
      throw new Error('unexpected external API');
    },
  });
  app.server.listen(ui, '127.0.0.1');
  app.callback.listen(callback, '127.0.0.1');
  await Promise.all([once(app.server, 'listening'), once(app.callback, 'listening')]);
  const base = `http://127.0.0.1:${ui}`,
    publicBase = `http://127.0.0.1:${callback}`,
    post = (path: string, data: unknown, token?: string, headers = {}) =>
      fetch(base + path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { 'X-ON-Token': token } : {}),
          ...headers,
        },
        body: JSON.stringify(data),
      });
  try {
    const boot = (await (await fetch(base + '/api/bootstrap')).json()) as any;
    assert.equal(boot.call.status, 'idle');
    assert.equal(boot.runtime.environment, 'local');
    assert.equal(boot.config.secrets.OPENAI_API_KEY, false);
    const missingCallback = await post('/api/callback/check', {}, boot.token);
    assert.equal(missingCallback.status, 400);
    assert.equal(((await missingCallback.json()) as any).error.code, 'public_url_missing');
    assert.equal((await post('/api/config', { TEST_PHONE: '01000000000' })).status, 403);
    assert.equal(
      (await post('/api/config', {}, boot.token, { Origin: 'https://evil.example' })).status,
      403,
    );
    assert.equal(
      (await post('/api/config', {}, boot.token, { 'Sec-Fetch-Site': 'cross-site' })).status,
      403,
    );
    const badHost = await new Promise<number>((resolve) => {
      const r = request(base + '/api/bootstrap', { headers: { Host: 'evil.example' } }, (res) => {
        resolve(res.statusCode!);
        res.resume();
      });
      r.end();
    });
    assert.equal(badHost, 403);
    for (const path of ['/.env', '/.data/settings.json', '/api/bootstrap', '/api/config', '/'])
      assert.equal((await fetch(publicBase + path)).status, 404);
    assert.equal(
      (await fetch(publicBase + '/webhooks/telnyx', { method: 'POST', body: '{}' })).status,
      401,
    );
    const invalid = new WebSocket(`ws://127.0.0.1:${callback}/media/${'0'.repeat(64)}`);
    const wsStatus = await new Promise<number>((resolve) => {
      invalid.on('unexpected-response', (_req, res) => {
        resolve(res.statusCode!);
        res.resume();
        invalid.terminate();
      });
      invalid.on('error', () => {});
    });
    assert.equal(wsStatus, 403);
    for (const path of ['/', '/telnyx', '/voice', '/app.js', '/voice.js'])
      assert.equal((await fetch(base + path)).status, 200);
    assert.equal(
      ((await (await fetch(base + '/api/health')).json()) as any).externalConnectionVerified,
      false,
    );
    assert.equal(
      (await post('/api/calls', { scenario: 'resident', consent: false }, boot.token)).status,
      400,
    );
    const saved = await (
      await post(
        '/api/config',
        { OPENAI_API_KEY: 'secret-test-value', TEST_PHONE: '01000000000' },
        boot.token,
      )
    ).json();
    assert.ok(!JSON.stringify(saved).includes('secret-test-value'));
    assert.equal(
      (await post('/api/recordings', { id: 'fake', data: 'AAAA', mime: 'audio/webm' }, boot.token))
        .status,
      403,
    );
    const receipt = (await (
      await post('/api/voice/transcripts', { delta: '대피소에 도착했어요' }, boot.token)
    ).json()) as any;
    assert.equal(receipt.accepted, false);
    assert.equal(receipt.source, 'browser_delivery_test');
    assert.equal(external, 0);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test('공개 검사 중 실제 전화·브라우저 동시 시작과 설정 변경을 잠그고 수동 취소는 발신 0회', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'on-reservation-')),
    ui = await port(),
    callback = await port();
  let resolveProbe!: (r: Response) => void,
    requests = 0,
    probeToken = '';
  const sockets: FakeSocket[] = [];
  const app = createApplication(process.cwd(), {
    env: { PORT: String(ui), CALLBACK_PORT: String(callback), ON_LOCAL_DATA_DIR: dir },
    fetcher: async (url) => {
      requests++;
      if (String(url).includes('/probe/')) {
        probeToken = String(url).split('/').at(-1)!;
        return new Promise((r) => (resolveProbe = r));
      }
      throw new Error('Dial must not happen');
    },
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      queueMicrotask(() => socket.emit('open'));
      return socket as unknown as WebSocket;
    },
  });
  app.store.save({
    OPENAI_API_KEY: 'test',
    TELNYX_API_KEY: 'test',
    TELNYX_APPLICATION_ID: '123456789',
    TELNYX_PUBLIC_KEY: Buffer.alloc(32).toString('base64'),
    PUBLIC_BASE_URL: 'https://fake.trycloudflare.com',
    CALLER_NUMBER: '+12025550103',
    TEST_PHONE: '01000000000',
  });
  app.server.listen(ui, '127.0.0.1');
  app.callback.listen(callback, '127.0.0.1');
  await Promise.all([once(app.server, 'listening'), once(app.callback, 'listening')]);
  const base = `http://127.0.0.1:${ui}`,
    boot = (await (await fetch(base + '/api/bootstrap')).json()) as any;
  const post = (path: string, data: unknown) =>
    fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-ON-Token': boot.token },
      body: JSON.stringify(data),
    });
  try {
    const pending = post('/api/calls', { scenario: 'resident', consent: true });
    for (let n = 0; n < 100 && !resolveProbe; n++) await flush();
    assert.ok(resolveProbe);
    assert.equal((await post('/api/config', { VOICE: 'marin' })).status, 409);
    assert.equal((await post('/api/voice/session', { consent: true, sdp: 'v=0' })).status, 409);
    await post('/api/calls/hangup', {});
    resolveProbe(Response.json({ onCallback: probeToken }));
    assert.equal((await pending).status, 409);
    assert.equal(requests, 1);
    assert.equal(sockets.length, 0);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
