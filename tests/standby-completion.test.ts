import test from 'node:test';
import assert from 'node:assert/strict';
import { CallManager } from '../src/calls.ts';
import { defaults } from '../src/config.ts';
import {
  classifyStandbyCompletion,
  standbyFarewell,
  standbyQuestions,
  type StandbyCompletion,
} from '../src/standby-completion.ts';
import type { Transcript } from '../src/evacuation.ts';
import type WebSocket from 'ws';
import { setup, media, hook, user, output, flush, FakeSocket } from './helpers.ts';
import { muLawRms } from '../src/media.ts';

const context: Transcript[] = [
  { speaker: 'assistant', text: standbyQuestions.participation },
  { speaker: 'user', text: '어, 네. 지금 참여 가능합니다. 지금 어디로 이동하면 될까요' },
  { speaker: 'assistant', text: '좋습니다. 그럼 차량 이용이 가능하신가요?' },
  { speaker: 'user', text: '네, 렉스턴 차량 이용할게요' },
  { speaker: 'assistant', text: '네, 감사합니다. 출발까지 얼마나 걸리시나요?' },
];
const latest = '지금 바로 출발하겠습니다';
const ready: StandbyCompletion = {
  state: 'ready',
  participationEvidence: '지금 참여 가능합니다',
  vehicleEvidence: '렉스턴 차량 이용할게요',
  readinessEvidence: latest,
  evidence: latest,
  confidence: 1,
};
test('대기조 첫 질문 음성을 준비하지 못하면 실제 발신을 요청하지 않는다', async () => {
  const s = setup();
  try {
    s.manager.factory = () => {
      const socket = new FakeSocket();
      socket.autoOpening = false;
      queueMicrotask(() => socket.emit('open'));
      return socket as unknown as WebSocket;
    };
    const view = await s.manager.start({ consent: true, scenario: 'standby' });
    assert.equal(view.status, 'failed');
    assert.equal(view.error?.code, 'opening_audio_timeout');
    assert.equal(s.requests.length, 0);
  } finally {
    s.cleanup();
  }
});
function response(result: StandbyCompletion) {
  return Response.json({
    status: 'completed',
    output: [{ content: [{ type: 'output_text', text: JSON.stringify(result) }] }],
  });
}
test('대기조도 발신 전에 음성을 준비하고 수신자 발화 없이 수신 2초 뒤 첫 질문을 한 번 재생한다', async (t) => {
  for (const mediaBeforeAnswer of [true, false]) {
    const s = setup();
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    try {
      await s.manager.start({ consent: true, scenario: 'standby' });
      assert.equal(s.manager.current.openingReady, true);
      assert.deepEqual(s.sockets[0].sent[0].session.delegation, { type: 'client' });
      assert.equal(s.manager.public().transcript.length, 0);
      let ms = mediaBeforeAnswer ? media(s.manager) : undefined;
      hook(s.manager, 'call.answered');
      t.mock.timers.tick(1999);
      assert.equal(s.manager.current.bridge?.active ?? false, false);
      assert.equal(ms?.sent.filter((e) => e.event === 'media').length ?? 0, 0);
      t.mock.timers.tick(1);
      if (!ms) ms = media(s.manager);
      assert.equal(s.manager.public().transcript[0].text, standbyQuestions.participation);
      assert.equal(s.manager.public().transcript.filter((t) => t.speaker === 'user').length, 0);
      t.mock.timers.tick(120);
      s.manager.current.bridge!.tick();
      assert.ok(
        ms.sent.some(
          (e) => e.event === 'media' && muLawRms(Buffer.from(e.media.payload, 'base64')) > 100,
        ),
      );
      hook(s.manager, 'call.answered', 'duplicate-answer');
      assert.equal(
        s.manager.public().events.filter((e) => e.type === 'opening_playback').length,
        1,
      );
    } finally {
      s.cleanup();
      t.mock.timers.reset();
    }
  }
});
test('대기조 참여·차량·준비 시간 질문을 앱이 진행하고 준비 완료 뒤 종료 안내로 마친다', async (t) => {
  const s = setup();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    await s.manager.start({ consent: true, scenario: 'standby' });
    media(s.manager);
    hook(s.manager, 'call.answered');
    t.mock.timers.tick(2000);
    const replies = ['참여 가능합니다', '렉스턴 차량 이용할게요', latest];
    s.manager.current.assessStandby = async (_config, text) => ({
      state: text === latest ? 'ready' : 'pending',
      participationEvidence: replies[0],
      vehicleEvidence: text === replies[0] ? '' : replies[1],
      readinessEvidence: text === latest ? latest : '',
      evidence: text,
      confidence: 1,
    });
    for (const [index, reply] of replies.entries()) {
      user(s.sockets[0], reply);
      t.mock.timers.tick(1500);
      await flush();
      if (index < 2) {
        const question = index === 0 ? standbyQuestions.vehicle : standbyQuestions.readiness;
        assert.equal(s.manager.current.questionLine, question);
        assert.equal(s.manager.public().completion, undefined);
        output(s.sockets[0], question);
      }
    }
    assert.equal(s.manager.public().completion!.kind, 'standby');
    assert.equal(s.manager.public().completion!.standbyAssessment!.state, 'ready');
    for (const question of Object.values(standbyQuestions))
      assert.equal(s.sockets[0].sent.filter((e) => e.content?.includes(question)).length, 1);
    assert.ok(s.sockets[0].sent.some((e) => e.content?.includes(standbyFarewell)));
  } finally {
    s.cleanup();
    t.mock.timers.reset();
  }
});
test('캡처 대기조 종료 분류는 수신자 세 답변과 최신 근거를 검증하고 low로 요청한다', async () => {
  let payload: any;
  const result = await classifyStandbyCompletion(
    defaults,
    latest,
    context,
    async (_url, options) => {
      payload = JSON.parse(String(options?.body));
      return response(ready);
    },
  );
  assert.deepEqual(result, ready);
  assert.equal(payload.model, 'gpt-6.1-sol');
  assert.deepEqual(payload.reasoning, { effort: 'low' });
  assert.equal(payload.text.format.strict, true);
  for (const invalid of [
    { ...ready, confidence: 0.8 },
    { ...ready, evidence: '다른 발화' },
    { ...ready, vehicleEvidence: '차량 이용이 가능하신가요?' },
    { ...ready, participationEvidence: '' },
    { ...ready, readinessEvidence: '10분 후' },
    { ...ready, state: 'pending' as const },
  ])
    assert.equal(
      await classifyStandbyCompletion(defaults, latest, context, async () => response(invalid)),
      null,
    );
  assert.equal(
    await classifyStandbyCompletion(defaults, latest, [], async () => response(ready)),
    null,
  );
  await assert.rejects(
    classifyStandbyCompletion(defaults, latest, context, async () =>
      Response.json({ status: 'incomplete' }),
    ),
  );
  await assert.rejects(
    classifyStandbyCompletion(
      defaults,
      latest,
      context,
      async () => new Response('', { status: 503 }),
    ),
  );
});
test('대기조 참여 불가도 최신 본인 거부 근거가 있어야 종료한다', async () => {
  const text = '오늘은 참여할 수 없습니다';
  const unavailable: StandbyCompletion = {
    state: 'unavailable',
    participationEvidence: text,
    vehicleEvidence: '',
    readinessEvidence: '',
    evidence: text,
    confidence: 1,
  };
  assert.deepEqual(
    await classifyStandbyCompletion(defaults, text, context.slice(0, 1), async () =>
      response(unavailable),
    ),
    unavailable,
  );
  assert.equal(
    await classifyStandbyCompletion(defaults, '잠깐 다시 확인해볼게요', context, async () =>
      response(unavailable),
    ),
    null,
  );
});
test('대기조 마지막 준비 시간 응답 → 결과 저장 → 종료 안내 음성·mark → hangup 1회 → 최종 종료', async (t) => {
  const s = setup();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    await s.manager.start({ consent: true, scenario: 'standby' });
    const ms = media(s.manager);
    hook(s.manager, 'call.answered');
    t.mock.timers.tick(2000);
    let residentCalls = 0;
    s.manager.current.classify = async () => {
      residentCalls++;
      return null;
    };
    s.manager.current.assessStandby = async (_config, text, history) => {
      assert.equal(text, latest);
      assert.deepEqual(history, [...context, { speaker: 'user', text: latest }]);
      return ready;
    };
    s.manager.current.view.transcript = structuredClone(context);
    user(s.sockets[0], latest);
    t.mock.timers.tick(1499);
    await flush();
    assert.equal(s.manager.public().completion, undefined);
    t.mock.timers.tick(1);
    await flush();
    assert.equal(residentCalls, 0);
    assert.equal(s.manager.public().completion!.kind, 'standby');
    assert.equal(s.manager.outcomeStore.list()[0].scenario, 'standby');
    assert.ok(s.sockets[0].sent.some((e) => e.content?.includes(standbyFarewell)));
    assert.equal(s.requests.length, 1);
    output(s.sockets[0], standbyFarewell, 640);
    for (let i = 0; i < 100; i++) {
      s.sockets[0].push({
        type: 'session.output_audio.delta',
        delta: Buffer.alloc(160, 255).toString('base64'),
      });
      t.mock.timers.tick(20);
      s.manager.current.bridge!.tick();
    }
    const mark = ms.sent.find((e) => e.event === 'mark');
    assert.ok(mark);
    ms.push(mark);
    await flush();
    assert.equal(s.requests.length, 2);
    assert.match(s.requests[1].url, /actions\/hangup$/);
    ms.push(mark);
    await s.manager.stop();
    assert.equal(s.requests.length, 2);
    assert.equal(s.manager.public().completion!.playbackConfirmed, true);
    hook(s.manager, 'call.hangup');
    assert.equal(s.manager.public().status, 'ended');
    assert.equal(s.manager.public().blocked, false);
    const restored = new CallManager(s.store, s.dir);
    assert.equal(restored.public().completion!.kind, 'standby');
    assert.deepEqual(restored.public().completion!.standbyAssessment, ready);
    assert.equal(restored.outcomeStore.list()[0].callStatus, 'ended');
    restored.dispose();
  } finally {
    s.cleanup();
    t.mock.timers.reset();
  }
});
test('대기조 AI 확인 전사만 있거나 재생 clear 후의 mark는 자동 종료 근거가 아니다', async (t) => {
  const s = setup();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    await s.manager.start({ consent: true, scenario: 'standby' });
    const ms = media(s.manager);
    hook(s.manager, 'call.answered');
    t.mock.timers.tick(2000);
    s.manager.current.assessStandby = async () => ready;
    user(s.sockets[0], latest);
    t.mock.timers.tick(1500);
    await flush();
    s.sockets[0].push({ type: 'session.output_transcript.delta', delta: standbyFarewell });
    t.mock.timers.tick(1500);
    s.manager.current.bridge!.tick();
    assert.equal(s.manager.current.mark, undefined);
    assert.equal(s.requests.length, 1);
    output(s.sockets[0], '', 160);
    t.mock.timers.tick(1500);
    s.manager.current.bridge!.tick();
    const mark = ms.sent.find((e) => e.event === 'mark');
    assert.ok(mark);
    s.manager.current.bridge!.clear();
    ms.push(mark);
    assert.equal(s.requests.length, 1);
    assert.equal(s.manager.public().completion!.playbackConfirmed, false);
  } finally {
    s.cleanup();
    t.mock.timers.reset();
  }
});
test('낡은 대기조 종료 판단·API 실패는 끊지 않고 60초 제한은 확인 완료로 기록하지 않는다', async (t) => {
  const s = setup();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    await s.manager.start({ consent: true, scenario: 'standby' });
    media(s.manager);
    hook(s.manager, 'call.answered');
    t.mock.timers.tick(2000);
    let resolve!: (value: StandbyCompletion) => void;
    s.manager.current.assessStandby = async () =>
      new Promise((r) => {
        resolve = r;
      });
    user(s.sockets[0], latest);
    t.mock.timers.tick(1500);
    await flush();
    user(s.sockets[0], '잠깐 아직 준비가 안 됐어요');
    resolve(ready);
    await flush();
    assert.equal(s.manager.public().completion, undefined);
    s.manager.current.assessStandby = async () => {
      throw new Error('API failed');
    };
    t.mock.timers.tick(1500);
    await flush();
    assert.equal(s.manager.public().completion, undefined);
    assert.equal(s.requests.length, 1);
    t.mock.timers.tick(55000);
    await flush();
    assert.equal(s.requests.length, 2);
    assert.equal(s.manager.public().completion, undefined);
  } finally {
    s.cleanup();
    t.mock.timers.reset();
  }
});
