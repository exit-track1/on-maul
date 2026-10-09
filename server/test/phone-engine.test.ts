import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { ConfigStore } from '../../src/config.ts';
import { FakeSocket, flush, user } from '../../tests/helpers.ts';
import { PhoneEngine, type PhoneEngineOptions } from '../src/phone.ts';
import type { PhoneUpdate } from '../../shared/src/phone.ts';

function setup(extra: Partial<PhoneEngineOptions> = {}, environment: Record<string, string> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'onmaul-dashboard-phone-'));
  const settingsDirectory = join(directory, 'poc');
  const activeDirectory = join(directory, 'dashboard');
  const store = new ConfigStore(settingsDirectory, {});
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  store.save({
    OPENAI_API_KEY: 'sk-test-phone-placeholder',
    TELNYX_API_KEY: 'telnyx-phone-placeholder',
    TELNYX_APPLICATION_ID: '123456789',
    TELNYX_PUBLIC_KEY: publicKey
      .export({ format: 'der', type: 'spki' })
      .subarray(-32)
      .toString('base64'),
    CALLER_NUMBER: '+12025550103',
    PUBLIC_BASE_URL: 'https://fake-call.trycloudflare.com',
    TEST_PHONE: '01000000000',
    LIVE_MODEL: 'gpt-live-1',
    BACKEND_MODEL: 'gpt-6.1-sol',
    VOICE: 'marin',
  });
  const sockets: FakeSocket[] = [];
  const requests: { url: string; body: Record<string, unknown> }[] = [];
  const updates: PhoneUpdate[] = [];
  const env = {
    ON_EXECUTION_MODE: 'hybrid',
    ON_PHONE_ENABLED: 'yes',
    REAL_RESIDENT_E164: '01000000001',
    REAL_RESIDENT_CONSENT: 'yes',
    REAL_GRANDMOTHER_E164: '01000000002',
    REAL_GRANDMOTHER_CONSENT: 'yes',
    REAL_SQUAD_E164: '01000000003',
    REAL_SQUAD_CONSENT: 'yes',
    ...environment,
  };
  let probeCount = 0;
  const options: PhoneEngineOptions = {
    root: directory,
    environment: env,
    directory: activeDirectory,
    store,
    requestTimeoutMs: 100,
    onUpdate: (update) => updates.push(update),
    fetcher: async (url, input) => {
      const path = String(url);
      if (path.includes('/probe/')) {
        probeCount++;
        return Response.json({ onCallback: path.split('/probe/')[1] });
      }
      const body = input?.body ? JSON.parse(String(input.body)) : {};
      requests.push({ url: path, body });
      if (path.includes('api.openai.com')) {
        return Response.json({
          status: 'completed',
          output: [
            {
              content: [
                {
                  type: 'output_text',
                  text: JSON.stringify({
                    l: null,
                    m: 'h',
                    c: 'u',
                    r: 'u',
                    e: null,
                    confidence: 0.99,
                    q: '차 보내주세요',
                  }),
                },
              ],
            },
          ],
        });
      }
      return Response.json({
        data: {
          call_control_id: `telnyx_${requests.filter((request) => request.url.endsWith('/calls')).length}`,
        },
      });
    },
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      queueMicrotask(() => socket.emit('open'));
      return socket as unknown as WebSocket;
    },
    ...extra,
  };
  const engine = new PhoneEngine(options);
  const hook = (type: string, overrides: Record<string, unknown> = {}) => {
    const payload = requests.findLast((request) => request.url.endsWith('/calls'))!.body;
    engine.webhook({
      data: {
        id: randomUUID(),
        event_type: type,
        payload: {
          call_control_id: engine.manager.public().callControlId,
          client_state: payload.client_state,
          to: payload.to,
          ...overrides,
        },
      },
    });
  };
  const media = () => {
    const socket = new FakeSocket();
    engine.manager.attachMedia(socket as unknown as WebSocket);
    socket.push({
      event: 'start',
      start: {
        client_state: engine.manager.current.clientState,
        call_control_id: engine.manager.public().callControlId,
        media_format: { encoding: 'PCMU', sample_rate: 8000, channels: 1 },
      },
    });
    return socket;
  };
  return {
    engine,
    store,
    directory,
    activeDirectory,
    options,
    requests,
    sockets,
    updates,
    privateKey,
    hook,
    media,
    get probeCount() {
      return probeCount;
    },
    cleanup() {
      engine.dispose();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('demo leaves settings and journals untouched and TEST_PHONE needs an explicit target binding', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'onmaul-phone-disabled-'));
  const untouched = join(directory, 'never-created');
  const engine = new PhoneEngine({
    environment: { ON_EXECUTION_MODE: 'demo', ON_PHONE_ENABLED: 'yes' },
    directory: untouched,
    settingsDirectory: untouched,
    fetcher: async () => {
      throw new Error('network forbidden');
    },
  });
  try {
    assert.equal(engine.state().enabled, false);
    assert.equal(engine.state().ready, false);
    await assert.rejects(engine.start('H012', 'demo'), /활성화/);
    assert.equal(existsSync(untouched), false);
  } finally {
    engine.dispose();
    rmSync(directory, { recursive: true, force: true });
  }

  const unbound = setup(
    {},
    {
      REAL_RESIDENT_E164: '',
      REAL_GRANDMOTHER_E164: '',
      REAL_SQUAD_E164: '',
    },
  );
  try {
    assert.equal(
      unbound.engine.state().targets.every((target) => !target.configured),
      true,
    );
    await assert.rejects(unbound.engine.start('H012', 'unbound'), /대상별/);
    assert.equal(unbound.requests.length, 0);
  } finally {
    unbound.cleanup();
  }

  const bound = setup(
    {},
    {
      REAL_RESIDENT_E164: '',
      REAL_GRANDMOTHER_E164: '',
      REAL_SQUAD_E164: '',
      ON_PHONE_TEST_TARGET_ID: 'H009',
      ON_PHONE_TEST_CONSENT: 'yes',
    },
  );
  try {
    assert.equal(bound.engine.state().targets.filter((target) => target.configured).length, 1);
    await assert.rejects(bound.engine.start('H012', 'wrong-target'), /대상별/);
    const call = await bound.engine.start('H009', 'bound-target');
    assert.equal(call.targetId, 'H009');
    assert.equal(bound.requests[0].body.to, '+821000000000');
  } finally {
    bound.cleanup();
  }
});

test('wrong callback instance is rejected before a voice socket or a carrier request', async () => {
  const s = setup({ fetcher: async () => Response.json({ onCallback: 'another-server' }) });
  try {
    await assert.rejects(s.engine.start('H012', 'wrong-callback'), /토큰/);
    assert.equal(s.sockets.length, 0);
    assert.equal(s.requests.length, 0);
    assert.equal(s.engine.state().busy, false);
    assert.equal(s.engine.state().calls.length, 0);
  } finally {
    s.cleanup();
  }
});

test('voice transcript and classifier use configured models; outcome waits for final hangup and history survives', async (t) => {
  const s = setup();
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  try {
    const savedConfig = readFileSync(s.store.path, 'utf8');
    const events: PhoneUpdate[] = [];
    s.engine.on('update', (event) => events.push(event));
    const call = await s.engine.start('H012', 'runtime-resident', '온빛 배움학교');
    assert.equal(s.probeCount, 1);
    assert.equal(s.requests.length, 1);
    assert.equal(s.requests[0].body.to, '+821000000001');
    assert.equal(
      s.requests[0].body.webhook_url,
      'https://fake-call.trycloudflare.com/webhooks/telnyx',
    );
    assert.match(String(s.requests[0].body.stream_url), /\/media\/[a-f0-9]{64}$/);
    assert.equal(s.sockets[0].sent[0].session.model, 'gpt-live-1');
    assert.equal(s.sockets[0].sent[0].session.audio.output.voice, 'marin');
    assert.equal(readFileSync(s.store.path, 'utf8'), savedConfig);
    assert.equal(s.store.value.TEST_PHONE, '+821000000000');
    await assert.rejects(s.engine.start('H009', 'duplicate-live'), /진행 중/);

    s.media();
    s.hook('call.answered');
    t.mock.timers.tick(2000);
    user(s.sockets[0], '차 보내주세요');
    t.mock.timers.tick(200);
    await flush();
    const classified = s.engine.state().calls[0];
    assert.equal(classified.completion?.kind, 'rescue');
    assert.equal(classified.completion?.assessment?.mobility, 'needs_help');
    assert.equal(classified.blocked, true);
    assert.equal(classified.endedAt, null);
    assert.equal(
      s.requests.find((request) => request.url.includes('api.openai.com'))?.body.model,
      'gpt-6.1-sol',
    );
    assert.ok(
      classified.transcript.some(
        (line) => line.speaker === 'user' && line.text === '차 보내주세요',
      ),
    );

    await s.engine.stop(call.id);
    assert.equal(s.engine.state().calls[0].status, 'ending');
    assert.equal(s.engine.state().busy, true);
    s.hook('call.hangup');
    const ended = s.engine.state().calls[0];
    assert.equal(ended.status, 'ended');
    assert.equal(ended.blocked, false);
    assert.notEqual(ended.endedAt, null);
    assert.ok(
      events.some(
        (event) => event.requestId === 'runtime-resident' && event.call.status === 'ended',
      ),
    );

    const historyPath = join(s.activeDirectory, 'phone-history.json');
    assert.equal(statSync(historyPath).mode & 0o777, 0o600);
    s.engine.dispose();
    const restored = new PhoneEngine(s.options);
    try {
      const history = restored.state().calls[0];
      assert.equal(history.targetId, 'H012');
      assert.equal(history.requestId, 'runtime-resident');
      assert.equal(history.completion?.kind, 'rescue');
      assert.deepEqual(history.transcript, ended.transcript);
      assert.equal(restored.state().busy, false);
    } finally {
      restored.dispose();
    }
  } finally {
    t.mock.timers.reset();
    s.cleanup();
  }
});

test('target bindings stay fixed across three calls; old provider events and secret transcripts cannot rebind', async () => {
  const s = setup({}, { ON_OPERATOR_TOKEN: 'private-operator-test-token' });
  try {
    const first = await s.engine.start('H012', 'request-1');
    const oldPayload = { ...s.requests[0].body, call_control_id: first.providerId };
    s.hook('call.hangup');
    const second = await s.engine.start('H009', 'request-2');
    s.engine.manager.current.view.transcript.push({
      speaker: 'user',
      text: 'sk-test-phone-placeholder telnyx-phone-placeholder private-operator-test-token +821000000002 01000000002',
    });
    s.engine.manager.publish();
    s.engine.webhook({
      data: { id: 'late-old-hangup', event_type: 'call.hangup', payload: oldPayload },
    });
    assert.equal(s.engine.state().calls.find((call) => call.id === second.id)?.status, 'created');
    s.hook('call.hangup');
    const third = await s.engine.start('M01', 'request-3', '온빛 배움학교', '서구역 9번 집');
    assert.equal(third.scenario, 'standby');
    assert.match(s.engine.manager.current.questionLine, /서구역 9번 집/);
    assert.doesNotMatch(s.engine.manager.current.questionLine, /8번 집/);
    assert.equal(s.requests.filter((request) => request.url.endsWith('/calls')).length, 3);
    assert.deepEqual(
      s.engine
        .state()
        .calls.map((call) => call.targetId)
        .sort(),
      ['H009', 'H012', 'M01'],
    );
    const publicState = JSON.stringify(s.engine.state());
    const history = readFileSync(join(s.activeDirectory, 'phone-history.json'), 'utf8');
    for (const content of [publicState, history]) {
      assert.ok(!content.includes('sk-test-phone-placeholder'));
      assert.ok(!content.includes('telnyx-phone-placeholder'));
      assert.ok(!content.includes('private-operator-test-token'));
      assert.ok(!content.includes('+821000000002'));
      assert.ok(!content.includes('01000000002'));
    }
    assert.equal(s.engine.state().calls.find((call) => call.id === first.id)?.targetId, 'H012');
  } finally {
    s.cleanup();
  }
});

test('dashboard active journal survives restart as unknown and only explicit end confirmation clears the lock', async () => {
  const s = setup();
  try {
    const call = await s.engine.start('H009', 'restart-request');
    s.engine.manager.current.view.transcript.push({ speaker: 'user', text: '집에 있습니다.' });
    s.engine.manager.publish();
    s.engine.dispose();
    const restored = new PhoneEngine(s.options);
    try {
      assert.equal(restored.state().busy, true);
      assert.equal(restored.state().calls[0].status, 'unknown');
      assert.equal(restored.state().calls[0].targetId, 'H009');
      assert.throws(() => restored.resolveUnknown(call.id, false), /확인/);
      restored.resolveUnknown(call.id, true);
      assert.equal(restored.state().calls[0].status, 'ended');
      assert.equal(restored.state().busy, false);
      assert.equal(restored.state().calls[0].transcript[0].text, '집에 있습니다.');
    } finally {
      restored.dispose();
    }
  } finally {
    s.cleanup();
  }
});

test('standby ready and unavailable assessments remain distinct in DTOs and persisted outcomes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  try {
    for (const state of ['ready', 'unavailable'] as const) {
      const s = setup();
      const text =
        state === 'ready'
          ? '참여 가능합니다. 차량 있습니다. 지금 바로 출발합니다.'
          : '지금은 참여할 수 없습니다.';
      const assessment = {
        state,
        participationEvidence: state === 'ready' ? '참여 가능합니다' : text,
        vehicleEvidence: state === 'ready' ? '차량 있습니다' : '',
        readinessEvidence: state === 'ready' ? '지금 바로 출발합니다' : '',
        evidence: text,
        confidence: 0.99,
      };
      s.engine.manager.fetcher = async (url, input) => {
        if (String(url).includes('api.openai.com'))
          return Response.json({
            status: 'completed',
            output: [
              {
                content: [
                  {
                    type: 'output_text',
                    text: JSON.stringify(assessment),
                  },
                ],
              },
            ],
          });
        return s.options.fetcher!(url, input);
      };
      try {
        await s.engine.start('M01', `squad-${state}`);
        s.media();
        s.hook('call.answered');
        t.mock.timers.tick(2000);
        user(s.sockets[0], text);
        t.mock.timers.tick(1500);
        await flush();
        const result = s.engine.state().calls[0];
        assert.equal(result.completion?.kind, 'standby');
        assert.deepEqual(result.completion?.standbyAssessment, assessment);
        assert.equal(result.blocked, true);
        s.hook('call.hangup');
        assert.equal(s.engine.state().calls[0].status, 'ended');
        assert.deepEqual(
          s.engine.manager.outcomeStore.list()[0].completion.standbyAssessment,
          assessment,
        );
        s.engine.dispose();
        const restored = new PhoneEngine(s.options);
        try {
          assert.deepEqual(restored.state().calls[0].completion?.standbyAssessment, assessment);
        } finally {
          restored.dispose();
        }
      } finally {
        s.cleanup();
      }
    }
  } finally {
    t.mock.timers.reset();
  }
});

test('signature validation and WSS media token attach to the same Node HTTP server', async () => {
  const s = setup();
  const server = createServer((_req, response) => response.end());
  s.engine.attachUpgrade(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `ws://127.0.0.1:${address.port}`;
  let media: WebSocket | undefined;
  try {
    await s.engine.start('H009', 'socket-request');
    const raw = Buffer.from(
      JSON.stringify({ data: { id: 'signed-test', event_type: 'call.answered', payload: {} } }),
    );
    const timestamp = String(Math.floor(Date.now() / 1000));
    const headers = {
      'telnyx-timestamp': timestamp,
      'telnyx-signature-ed25519': sign(
        null,
        Buffer.concat([Buffer.from(`${timestamp}|`), raw]),
        s.privateKey,
      ).toString('base64'),
    };
    assert.equal(s.engine.verifyWebhook(raw, headers), true);
    assert.equal(s.engine.verifyWebhook(Buffer.from('{}'), headers), false);
    const badStatus = await new Promise<number>((resolve, reject) => {
      const invalid = new WebSocket(`${base}/media/${'0'.repeat(64)}`);
      invalid.on('unexpected-response', (_request, response) => {
        response.resume();
        invalid.terminate();
        resolve(response.statusCode!);
      });
      invalid.on('error', () => {});
      invalid.on('open', () => reject(new Error('invalid token accepted')));
    });
    assert.equal(badStatus, 403);
    media = new WebSocket(`${base}/media/${s.engine.manager.current.token}`);
    await new Promise<void>((resolve, reject) => {
      media!.once('open', resolve);
      media!.once('error', reject);
    });
    media.send(
      JSON.stringify({
        event: 'start',
        start: {
          client_state: s.engine.manager.current.clientState,
          call_control_id: s.engine.manager.public().callControlId,
          media_format: { encoding: 'PCMU', sample_rate: 8000, channels: 1 },
        },
      }),
    );
    for (let attempt = 0; attempt < 10 && !s.engine.manager.public().mediaConnected; attempt++)
      await flush();
    assert.equal(s.engine.manager.public().mediaConnected, true);
  } finally {
    media?.terminate();
    s.engine.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    s.cleanup();
  }
});
