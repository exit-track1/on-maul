import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type WebSocket from 'ws';
import { ConfigStore } from '../src/config.ts';
import { CallOutcomeStore } from '../src/call-outcomes.ts';
import { VoiceDemo } from '../src/voice-demo.ts';
import { checkConnection, checkModelAccess } from '../src/model-access.ts';
import { DisasterEngine } from '../src/disaster.ts';
import { farewell } from '../src/domain.ts';
import { FakeSocket, flush, setup, params, media, hook, output, user } from './helpers.ts';

test('완료 기록 최근 50개 역순·재시작 보존·손상 파일 보존과 파일 권한', () => {
  const dir = mkdtempSync(join(tmpdir(), 'on-outcomes-'));
  try {
    const records = new CallOutcomeStore(join(dir, 'call-outcomes'));
    for (let i = 0; i < 55; i++)
      records.save({
        callId: randomUUID(),
        sessionId: null,
        phone: '+821000000000',
        scenario: 'resident',
        completion: {
          status: 'reported',
          location: '대피 장소 미상',
          evidence: '도착했어요',
          recordedAt: i,
          playbackConfirmed: false,
        },
        callStatus: 'ended',
        endedAt: i + 1,
      });
    const broken = join(records.directory, randomUUID() + '.json');
    writeFileSync(broken, '{broken');
    const restored = new CallOutcomeStore(records.directory).list();
    assert.equal(restored.length, 50);
    assert.equal(restored[0].completion.recordedAt, 54);
    assert.equal(restored[49].completion.recordedAt, 5);
    assert.ok(existsSync(broken));
    assert.equal(statSync(records.directory).mode & 0o777, 0o700);
    assert.equal(
      statSync(join(records.directory, restored[0].callId + '.json')).mode & 0o777,
      0o600,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('WebRTC 생성 중 종료 의도는 늦은 세션을 닫고 새 통화를 생성하지 않음', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'on-voice-cancel-')),
    store = new ConfigStore(dir, {});
  store.save({ OPENAI_API_KEY: 'test' });
  let resolve!: (r: Response) => void,
    requests = 0,
    socket!: FakeSocket;
  const voice = new VoiceDemo(
    store,
    async () => {
      requests++;
      return new Promise((r) => {
        resolve = r;
      });
    },
    () => {
      socket = new FakeSocket();
      queueMicrotask(() => socket.emit('open'));
      return socket as unknown as WebSocket;
    },
  );
  try {
    voice.stop('');
    assert.equal(voice.public().status, 'idle');
    const pending = voice.start({ consent: true, sdp: 'v=0\r\noffer' });
    voice.stop(voice.public().id);
    assert.equal(voice.public().status, 'ending');
    assert.throws(() => voice.ready(voice.public().id));
    await assert.rejects(voice.start({ consent: true, sdp: 'v=0' }));
    resolve(Response.json({ session: { id: 'late_voice' }, transport: { sdp: 'v=0\r\nanswer' } }));
    await assert.rejects(pending, /종료 요청/);
    await flush();
    assert.equal(socket.sent.filter((e) => e.type === 'session.close').length, 1);
    assert.equal(voice.public().status, 'ended');
    assert.equal(voice.busy(), false);
    assert.equal(requests, 1);
  } finally {
    voice.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('연결 확인은 앱·실제 프로필·KR 설정과 Live 준비를 조회하며 발신하지 않음', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'on-connection-')),
    store = new ConfigStore(dir, {});
  store.save({
    OPENAI_API_KEY: 'test',
    TELNYX_API_KEY: 'test',
    TELNYX_APPLICATION_ID: '123456789',
    LIVE_MODEL: 'configured-live',
    BACKEND_MODEL: 'configured-backend',
    PLANNING_MODEL: 'configured-plan',
  });
  const requests: string[] = [];
  const fetcher: typeof fetch = async (url) => {
    const address = String(url);
    requests.push(address);
    if (address.includes('call_control_applications'))
      return Response.json({
        data: { active: true, outbound: { outbound_voice_profile_id: 'profile-test' } },
      });
    if (address.includes('outbound_voice_profiles'))
      return Response.json({ data: { enabled: true, whitelisted_destinations: ['KR'] } });
    if (address.includes('/models/')) return Response.json({ id: address.split('/').at(-1) });
    throw new Error('unexpected request');
  };
  try {
    let sessionConfiguration: any;
    const check = await checkConnection(store, fetcher, () => {
      const socket = new FakeSocket();
      const originalSend = socket.send.bind(socket);
      socket.send = (raw) => {
        const event = JSON.parse(raw);
        if (event.type === 'session.start') sessionConfiguration = event.session;
        originalSend(raw);
      };
      queueMicrotask(() => socket.emit('open'));
      return socket as unknown as WebSocket;
    });
    assert.equal(check.checks.length, 3);
    assert.ok(check.checks.every((c) => c.ok));
    assert.deepEqual(sessionConfiguration.delegation, { type: 'client' });
    assert.ok(!requests.some((u) => u.endsWith('/calls')));
    const models = await checkModelAccess(store, fetcher);
    assert.deepEqual(
      models.checks.map((c) => c.name),
      ['configured-live', 'configured-backend', 'configured-plan'],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('다른 통화 ID·잘못된 미디어 형식은 첫 안내를 재생하지 않음', async () => {
  for (const invalid of [
    { call_control_id: 'another_call' },
    { media_format: { encoding: 'L16', sample_rate: 16000, channels: 1 } },
  ]) {
    const s = setup();
    try {
      await s.manager.start(params);
      hook(s.manager, 'call.answered');
      const ms = new FakeSocket();
      s.manager.attachMedia(ms as unknown as WebSocket);
      ms.push({
        event: 'start',
        start: {
          client_state: s.manager.current.clientState,
          call_control_id: 'telnyx_test',
          media_format: { encoding: 'PCMU', sample_rate: 8000, channels: 1 },
          ...invalid,
        },
      });
      await flush();
      assert.equal(s.manager.public().error?.code, 'media_identity_invalid');
      assert.equal(ms.sent.filter((e) => e.event === 'media').length, 0);
      assert.equal(s.requests.length, 2);
    } finally {
      s.cleanup();
    }
  }
});

test('mark 뒤 늦은 오디오는 이전 mark를 무효화하고 마지막 오디오 재생을 기다림', async (t) => {
  const s = setup();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    await s.manager.start(params);
    const ms = media(s.manager);
    hook(s.manager, 'call.answered');
    t.mock.timers.tick(2000);
    s.manager.complete(s.manager.current, { location: '학교', evidence: '학교 도착' });
    output(s.sockets[0], farewell, 160);
    t.mock.timers.tick(1500);
    s.manager.current.bridge!.tick();
    const first = ms.sent.find((e) => e.event === 'mark');
    assert.ok(first);
    s.sockets[0].push({
      type: 'session.output_audio.delta',
      delta: Buffer.alloc(160, 0).toString('base64'),
    });
    ms.push(first);
    assert.equal(s.requests.length, 1);
    t.mock.timers.tick(1500);
    s.manager.current.bridge!.tick();
    const last = ms.sent.filter((e) => e.event === 'mark').at(-1);
    assert.notEqual(first.mark.name, last.mark.name);
    ms.push(last);
    await flush();
    assert.equal(s.requests.length, 2);
  } finally {
    s.cleanup();
    t.mock.timers.reset();
  }
});

test('상황실 모의 재시도 한도·참여 거절·실제 대기조 전사는 주민 완료로 처리하지 않음', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'on-retry-')),
    store = new ConfigStore(dir, {}),
    engine = new DisasterEngine(process.cwd(), dir, store);
  const s = setup();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    engine.command('watch');
    engine.command('propose');
    engine.command('approve', { approved: true });
    const target = engine.state.contacts.find((c) => c.scenario === 'resident')!;
    for (let i = 0; i < 4; i++) engine.command('retry', { targetId: target.targetId });
    assert.equal(target.sms, 5);
    assert.throws(() => engine.command('retry', { targetId: target.targetId }));
    const call = engine.prepare({ scenario: 'standby', targetId: 'T1' });
    engine.bind(call.id, 'standby-test', 'telnyx');
    await engine.classify(call.id, '참여 가능하지 않아요', [], () => true);
    assert.equal(engine.state.teams[0].available, false);
    await s.manager.start(
      { ...params, scenario: 'standby' },
      {
        classifier: async (_c, text, context, valid) =>
          engine.classify(call.id, text, context, valid),
      },
    );
    media(s.manager);
    hook(s.manager, 'call.answered');
    user(s.sockets[0], '참여 가능합니다');
    t.mock.timers.tick(1500);
    await flush();
    assert.equal(engine.state.teams[0].available, true);
    assert.equal(s.manager.public().completion, undefined);
    assert.equal(s.requests.length, 1);
  } finally {
    s.cleanup();
    rmSync(dir, { recursive: true, force: true });
    t.mock.timers.reset();
  }
});

test('상황실은 열린 대피소·정원·긴급 상태와 저장 성공 후에만 안전 자기 신고를 확정', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'on-safe-commit-')),
    store = new ConfigStore(dir, {});
  store.save({ OPENAI_API_KEY: 'test' });
  let text = '';
  const fetcher: typeof fetch = async () =>
    Response.json({
      status: 'completed',
      output: [
        {
          content: [
            {
              type: 'output_text',
              text: JSON.stringify({
                evacuated: true,
                location: '온빛 배움학교',
                evidence: text,
                needsHelp: false,
                confidence: 0.99,
              }),
            },
          ],
        },
      ],
    });
  const engine = new DisasterEngine(process.cwd(), dir, store, fetcher);
  try {
    engine.command('watch');
    engine.command('propose');
    engine.command('approve', { approved: true });
    const h = engine.state.households.find((h) => h.callEligible && h.consentToCall)!,
      shelter = engine.state.shelters.find((s) => s.name === '온빛 배움학교')!,
      call = engine.prepare({ targetId: h.id });
    engine.bind(call.id, 'validated-live', 'telnyx');
    text = '온빛 배움학교에 도착했어요';
    shelter.open = false;
    assert.equal(await engine.classify(call.id, text, [], () => true), null);
    shelter.open = true;
    const capacity = shelter.capacity;
    shelter.capacity = 0;
    assert.equal(await engine.classify(call.id, text, [], () => true), null);
    shelter.capacity = capacity;
    h.emergency = true;
    assert.equal(await engine.classify(call.id, text, [], () => true), null);
    h.emergency = false;
    const save = engine.save.bind(engine);
    engine.save = () => {
      throw new Error('disk unavailable');
    };
    await assert.rejects(
      engine.classify(call.id, text, [], () => true),
      /disk unavailable/,
    );
    assert.notEqual(engine.state.households.find((item) => item.id === h.id)!.status, 'safe');
    engine.save = save;
    assert.ok(await engine.classify(call.id, text, [], () => true));
    const restored = new DisasterEngine(process.cwd(), dir, store, fetcher);
    assert.equal(restored.state.households.find((item) => item.id === h.id)!.status, 'safe');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
