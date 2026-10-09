import test from 'node:test';
import assert from 'node:assert/strict';
import { CallManager } from '../src/calls.ts';
import { defaults } from '../src/config.ts';
import {
  classifyStandbyCompletion,
  standbyFarewell,
  type StandbyCompletion,
} from '../src/standby-completion.ts';
import type { Transcript } from '../src/evacuation.ts';
import { setup, media, hook, user, output, flush } from './helpers.ts';

const context: Transcript[] = [
  { speaker: 'assistant', text: '가상의 구조 요청에 참여 가능하신가요?' },
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
function response(result: StandbyCompletion) {
  return Response.json({
    status: 'completed',
    output: [{ content: [{ type: 'output_text', text: JSON.stringify(result) }] }],
  });
}
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
    t.mock.timers.tick(57000);
    await flush();
    assert.equal(s.requests.length, 2);
    assert.equal(s.manager.public().completion, undefined);
  } finally {
    s.cleanup();
    t.mock.timers.reset();
  }
});
