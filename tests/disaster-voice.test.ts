import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type WebSocket from 'ws';
import { ConfigStore } from '../src/config.ts';
import { DisasterEngine } from '../src/disaster.ts';
import { VoiceDemo } from '../src/voice-demo.ts';
import { FakeSocket, flush } from './helpers.ts';
test('48가구·8개 대기조·6대 차량, 승인·대상·배차 제약과 인증된 가구 근거 먼저 저장', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'on-disaster-')),
    store = new ConfigStore(dir, {});
  store.save({ OPENAI_API_KEY: 'test' });
  let evidence = '온빛 배움학교에 도착했어요';
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
                evidence,
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
    assert.equal(engine.state.households.length, 48);
    assert.equal(engine.state.teams.length, 8);
    assert.equal(engine.state.vehicles.length, 6);
    assert.throws(() => engine.prepare({ targetId: engine.state.households[0].id }));
    engine.command('watch');
    engine.command('propose');
    assert.throws(() => engine.command('approve', { approved: false }));
    engine.command('approve', { approved: true });
    const h = engine.state.households.find((h) => h.callEligible && h.consentToCall)!;
    const call = engine.prepare({ targetId: h.id, transport: 'telnyx' });
    engine.bind(call.id, 'live-test', 'telnyx');
    assert.equal(await engine.classify(call.id, '알겠어요', [], () => true), null);
    const report = await engine.classify(call.id, evidence, [], () => true);
    assert.ok(report);
    assert.equal(h.status, 'safe');
    assert.equal(report.targetId, h.id);
    assert.deepEqual(engine.state.runs.find((r) => r.result === 'safe')!.nodes, [
      'read_transcript',
      'classify',
      'validate_evidence',
      'commit',
    ]);
    assert.throws(() => engine.command('dispatch', { targetId: h.id, vehicleId: 'V1' }));
    engine.end(call.id);
    assert.throws(() => engine.linked(call.id));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('상황실 비동기 generation 무효화·정원·긴급·타인·도움 근거는 안전 처리하지 않음', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'on-graph-')),
    store = new ConfigStore(dir, {});
  store.save({ OPENAI_API_KEY: 'test' });
  let resolve!: (r: Response) => void;
  const engine = new DisasterEngine(
    process.cwd(),
    dir,
    store,
    async () => new Promise((r) => (resolve = r)),
  );
  try {
    engine.command('watch');
    engine.command('propose');
    engine.command('approve', { approved: true });
    const h = engine.state.households.find((h) => h.callEligible && h.consentToCall)!,
      call = engine.prepare({ targetId: h.id });
    let valid = true;
    const text = engine.state.shelters[0].name + '에 도착했어요',
      pending = engine.classify(call.id, text, [], () => valid);
    while (!resolve) await flush();
    valid = false;
    resolve(
      Response.json({
        status: 'completed',
        output: [
          {
            content: [
              {
                type: 'output_text',
                text: JSON.stringify({
                  evacuated: true,
                  location: engine.state.shelters[0].name,
                  evidence: text,
                  needsHelp: false,
                  confidence: 0.99,
                }),
              },
            ],
          },
        ],
      }),
    );
    assert.equal(await pending, null);
    assert.notEqual(h.status, 'safe');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('WebRTC SDP·서버 sideband·실제 전사와 브라우저 자동 hangup 없음', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'on-webrtc-')),
    store = new ConfigStore(dir, {});
  store.save({
    OPENAI_API_KEY: 'test',
    LIVE_MODEL: 'configured-live',
    BACKEND_MODEL: 'configured-backend',
  });
  let payload: any,
    url = '',
    socket!: FakeSocket;
  const voice = new VoiceDemo(
    store,
    async (_url, options) => {
      payload = JSON.parse(String(options?.body));
      return Response.json({
        session: { id: 'live_webrtc_test' },
        transport: { sdp: 'v=0\r\nanswer' },
      });
    },
    (target) => {
      url = target;
      socket = new FakeSocket();
      queueMicrotask(() => socket.emit('open'));
      return socket as unknown as WebSocket;
    },
  );
  try {
    await assert.rejects(voice.start({ consent: false, sdp: 'v=0' }));
    const answer = await voice.start({ consent: true, sdp: 'v=0\r\noffer', scenario: 'resident' });
    assert.equal(payload.session.model, 'configured-live');
    assert.equal(payload.session.delegation.responses.model, 'configured-backend');
    assert.equal(payload.transport.type, 'webrtc');
    assert.match(url, /\/live_webrtc_test\/attach$/);
    assert.ok(!socket.sent.some((e) => e.type === 'session.start'));
    voice.ready(answer.id);
    socket.push({
      type: 'session.input_transcript.delta',
      delta: '학교에 도착했어요',
      event_id: 'trusted',
    });
    assert.equal(voice.public().transcript[0].text, '학교에 도착했어요');
    assert.equal(voice.public().status, 'connected');
    assert.ok(!socket.sent.some((e) => e.type === 'session.close'));
    voice.stop(answer.id);
    await flush();
    assert.equal(voice.public().status, 'ended');
  } finally {
    voice.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});
