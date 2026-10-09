import test from 'node:test';
import assert from 'node:assert/strict';
import type WebSocket from 'ws';
import { CallManager } from '../src/calls.ts';
import { DisasterEngine } from '../src/disaster.ts';
import { defaults } from '../src/config.ts';
import {
  classifyResident,
  unknownResidentAnswer,
  type ResidentAnswer,
} from '../src/resident-classifier.ts';
import {
  applyResidentAnswer,
  finishResident,
  residentAssessment,
  residentQuestion,
  residentQuestions,
  rescueFarewell,
  movingFarewell,
  refusalFarewell,
  reviewFarewell,
} from '../src/resident-flow.ts';
import { setup, params, media, hook, user, output, flush, FakeSocket } from './helpers.ts';

function facts(text: string, values: Partial<Omit<ResidentAnswer, 'evidence'>>) {
  const answer = { ...unknownResidentAnswer(), confidence: 1, ...values };
  for (const key of Object.keys(answer.evidence) as (keyof ResidentAnswer['evidence'])[])
    if (key in values) answer.evidence[key] = text;
  return answer;
}
function apply(
  a: ReturnType<typeof residentAssessment>,
  text: string,
  values: Partial<ResidentAnswer>,
) {
  applyResidentAnswer(a, text, facts(text, values), residentQuestion(a));
}
test('캡처 회귀: 여보세요는 위치가 아니며 몸이 괜찮다는 답만으로 구조·이동 가능을 추정하지 않음', () => {
  const a = residentAssessment();
  apply(a, '여보세요', { location: '여보세요' });
  assert.equal(a.location, '위치 미확인');
  assert.equal(a.stage, 'mobility');
  assert.equal(a.answers.length, 0);
  apply(a, '어 지금 집이에요', { location: '집' });
  assert.equal(a.stage, 'mobility');
  assert.match(residentQuestion(a), /대피하셔야 합니다\. 온빛 배움학교로 이동 가능하십니까\?/);
  apply(a, '아니요, 몸이 불편하지 않습니다', { condition: 'comfortable' });
  assert.equal(a.condition, 'comfortable');
  assert.equal(a.mobility, 'unknown');
  assert.equal(a.stage, 'mobility');
  assert.equal(finishResident(a).kind, 'review');
});
test('세 종료 분기는 근거 있는 이동 가능·이동 불가·대피 거부이며 모호함은 담당자 확인', () => {
  for (const [values, kind, closing] of [
    [{ mobility: 'possible', condition: 'comfortable' }, 'moving', movingFarewell],
    [{ mobility: 'needs_help', condition: 'comfortable' }, 'rescue', rescueFarewell],
    [{ mobility: 'needs_help', condition: 'uncomfortable' }, 'rescue', rescueFarewell],
    [{ refusal: 'refused' }, 'refused', refusalFarewell],
    [{ condition: 'uncomfortable' }, 'review', reviewFarewell],
    [{ condition: 'comfortable' }, 'review', reviewFarewell],
    [{}, 'review', reviewFarewell],
  ] as const) {
    const a = residentAssessment();
    apply(a, '집이에요', { location: '집' });
    apply(a, '원문 응답', values);
    const result = finishResident(a);
    assert.equal(result.kind, kind);
    assert.equal(result.closingText, closing);
  }
});
test('근거 없는 사실·낮은 신뢰도·부정 정정은 잘못된 이동 가능 판단을 남기지 않는다', () => {
  const a = residentAssessment();
  apply(a, '집이야', { location: '집' });
  const bad = facts('다른 발화', { mobility: 'possible' });
  applyResidentAnswer(a, '몸은 괜찮아', bad);
  assert.equal(a.mobility, 'unknown');
  const low = facts('갈 수 있어요', { mobility: 'possible' });
  low.confidence = 0.4;
  applyResidentAnswer(a, '갈 수 있어요', low);
  assert.equal(a.mobility, 'unknown');
  apply(a, '갈 수 있어요', { mobility: 'possible' });
  assert.equal(a.stage, 'condition');
  apply(a, '아니, 차가 없어서 못 가요', { mobility: 'needs_help' });
  assert.equal(finishResident(a).kind, 'rescue');
});
test('첫 대피 질문의 답을 180ms 뒤 분류하고 위치 질문 없이 몸 상태 확인 후 종료한다', async (t) => {
  const s = setup();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    await s.manager.start(params);
    media(s.manager);
    hook(s.manager, 'call.answered');
    t.mock.timers.tick(2000);
    let classified = 0;
    s.manager.current.assess = async (_config, text, _assessment, question) => {
      classified++;
      assert.equal(question, residentQuestion(residentAssessment()));
      return facts(text, { mobility: 'possible' });
    };
    user(s.sockets[0], '네 이동 가능해요');
    t.mock.timers.tick(179);
    await flush();
    assert.equal(classified, 0);
    t.mock.timers.tick(1);
    await flush();
    assert.equal(classified, 1);
    assert.equal(s.manager.public().assessment!.stage, 'condition');
    assert.equal(s.manager.current.questionLine, '몸이 불편하신가요?');
    output(s.sockets[0], s.manager.current.questionLine);
    s.manager.current.assess = async (_config, text, _assessment, question) => {
      assert.equal(question, '몸이 불편하신가요?');
      return facts(text, { condition: 'comfortable' });
    };
    user(s.sockets[0], '아니요 몸은 괜찮아요');
    t.mock.timers.tick(180);
    await flush();
    assert.equal(s.manager.public().completion!.kind, 'moving');
    assert.equal(s.manager.public().completion!.closingText, movingFarewell);
    assert.equal(s.manager.public().assessment!.location, '위치 미확인');
    assert.ok(!s.sockets[0].sent.some((e) => e.content?.includes('지금 어디십니까?')));
  } finally {
    s.cleanup();
    t.mock.timers.reset();
  }
});
test('gpt-6.1-sol 실제 Responses payload·질문 문맥·원문 근거 검증, 미완료·API 오류는 실패', async () => {
  let payload: any;
  const text = '몸은 괜찮지만 차가 없어요';
  const expected = facts(text, { mobility: 'needs_help', condition: 'comfortable' });
  const fetcher: typeof fetch = async (url, options) => {
    assert.equal(String(url), 'https://api.openai.com/v1/responses');
    payload = JSON.parse(String(options!.body));
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
                c: 'ok',
                r: 'u',
                e: null,
                confidence: 1,
                q: text,
              }),
            },
          ],
        },
      ],
    });
  };
  const a = residentAssessment();
  a.stage = 'mobility';
  const answer = await classifyResident(defaults, text, a, residentQuestion(a), fetcher);
  assert.deepEqual(answer, expected);
  assert.equal(payload.model, 'gpt-6.1-sol');
  assert.deepEqual(payload.reasoning, { effort: 'low' });
  assert.equal(payload.store, false);
  assert.equal(payload.text.format.strict, true);
  assert.equal(JSON.parse(payload.input).spokenQuestion, residentQuestion(a));
  for (const response of [
    Response.json({ status: 'incomplete' }),
    Response.json({}, { status: 429 }),
    Response.json({
      status: 'completed',
      output: [
        {
          content: [
            {
              type: 'output_text',
              text: JSON.stringify({
                l: null,
                m: 'p',
                c: 'u',
                r: 'u',
                e: null,
                confidence: 1,
                q: '다른 원문',
              }),
            },
          ],
        },
      ],
    }),
  ])
    await assert.rejects(classifyResident(defaults, text, a, '', async () => response));
});
test('발신 전에 첫 질문 준비, 무음 선두 제외, 수신 2초 후 자동 재생·늦은 미디어·중복 이벤트', async (t) => {
  const s = setup();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    s.manager.factory = () => {
      const socket = new FakeSocket();
      socket.autoOpening = false;
      const send = socket.send.bind(socket);
      socket.send = (raw) => {
        send(raw);
        const e = JSON.parse(raw);
        if (e.type === 'session.instructions.append')
          queueMicrotask(() => {
            socket.push({
              type: 'session.output_audio.delta',
              delta: Buffer.alloc(16000, 255).toString('base64'),
            });
            output(socket, residentQuestion(residentAssessment()), 1280);
          });
      };
      s.sockets.push(socket);
      queueMicrotask(() => socket.emit('open'));
      return socket as unknown as WebSocket;
    };
    await s.manager.start(params);
    assert.equal(s.manager.current.openingBytes, 1280);
    assert.equal(s.manager.public().transcript.length, 0);
    const ms = media(s.manager);
    hook(s.manager, 'call.answered');
    hook(s.manager, 'call.answered');
    t.mock.timers.tick(1999);
    assert.equal(s.manager.current.bridge!.active, false);
    assert.equal(ms.sent.length, 0);
    t.mock.timers.tick(1);
    assert.equal(s.manager.current.bridge!.active, true);
    assert.equal(s.manager.current.bridge!.output.length, 1280);
    assert.equal(s.manager.public().transcript[0].text, residentQuestion(residentAssessment()));
    assert.equal(s.manager.public().events.filter((e) => e.type === 'opening_playback').length, 1);
    assert.equal(s.requests.length, 1);
    hook(s.manager, 'call.hangup');
    await s.manager.start(params);
    hook(s.manager, 'call.answered', 'second-answer');
    t.mock.timers.tick(2500);
    const late = media(s.manager);
    assert.equal(s.manager.current.bridge!.active, true);
    assert.ok(!late.sent.some((e) => e.event === 'media'));
    s.manager.current.bridge!.tick();
    s.manager.current.bridge!.tick(Date.now() + 120);
    assert.ok(late.sent.some((e) => e.event === 'media'));
  } finally {
    s.cleanup();
    t.mock.timers.reset();
  }
});
test('첫 질문이 생성되지 않거나 음성·전사만 있으면 실제 발신 0회', async (t) => {
  for (const audioOnly of [false, true]) {
    const s = setup();
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    try {
      s.manager.factory = () => {
        const socket = new FakeSocket();
        socket.autoOpening = false;
        s.sockets.push(socket);
        queueMicrotask(() => socket.emit('open'));
        return socket as unknown as WebSocket;
      };
      const started = s.manager.start(params);
      await flush();
      if (audioOnly)
        s.sockets[0].push({
          type: 'session.output_audio.delta',
          delta: Buffer.alloc(640, 0).toString('base64'),
        });
      else
        s.sockets[0].push({
          type: 'session.output_transcript.delta',
          delta: residentQuestion(residentAssessment()),
        });
      t.mock.timers.tick(100);
      await started;
      assert.equal(s.requests.length, 0);
      assert.equal(s.manager.public().status, 'failed');
      assert.equal(s.manager.public().error!.code, 'opening_audio_timeout');
    } finally {
      s.cleanup();
      t.mock.timers.reset();
    }
  }
});
test('인사→집→몸이 괜찮음은 이동 질문 유지, 실제 세 분기 모두 저장→mark→1회 종료', async (t) => {
  for (const [text, values, kind, closing] of [
    ['걸어서 갈 수 있어요', { mobility: 'possible' }, 'moving', movingFarewell],
    [
      '몸은 괜찮지만 차가 없어서 못 가요',
      { mobility: 'needs_help', condition: 'comfortable' },
      'rescue',
      rescueFarewell,
    ],
    [
      '다리가 아파서 걸을 수 없어요',
      { mobility: 'needs_help', condition: 'uncomfortable' },
      'rescue',
      rescueFarewell,
    ],
    ['집을 두고 떠날 수 없어요', { refusal: 'refused' }, 'refused', refusalFarewell],
  ] as const) {
    const s = setup();
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    try {
      await s.manager.start(params, { shelterName: '온빛 배움학교' });
      const ms = media(s.manager);
      hook(s.manager, 'call.answered');
      t.mock.timers.tick(2000);
      const socket = s.sockets[0];
      const reply = async (value: string, fields: Partial<ResidentAnswer>) => {
        s.manager.current.assess = async () => facts(value, fields);
        output(socket, s.manager.current.questionLine);
        user(socket, value);
        t.mock.timers.tick(180);
        await flush();
      };
      user(socket, '여보세요');
      t.mock.timers.tick(180);
      await flush();
      assert.equal(s.manager.public().assessment!.stage, 'mobility');
      await reply('어 지금 집이에요', { location: '집' });
      await reply('아니요 몸이 불편하지 않습니다', { condition: 'comfortable' });
      assert.equal(s.manager.public().completion, undefined);
      assert.equal(s.manager.public().assessment!.stage, 'mobility');
      await reply(text, values);
      const completion = s.manager.outcomeStore.list()[0].completion;
      assert.equal(completion.kind, kind);
      assert.equal(completion.closingText, closing);
      assert.equal(completion.location, '집');
      assert.equal(s.requests.length, 1);
      const instructions = socket.sent
        .filter((e) => e.type === 'session.instructions.append')
        .map((e) => e.content)
        .join('\n');
      assert.match(instructions, /대피하셔야 합니다\. 온빛 배움학교로 이동 가능하십니까/);
      assert.ok(!/테스트 전화|안내라는 점을 이해/.test(instructions));
      output(socket, closing, 1280);
      t.mock.timers.tick(1500);
      const now = Date.now();
      for (let i = 0; i < 5; i++) s.manager.current.bridge!.tick(now + i * 60);
      const mark = ms.sent.find((e) => e.event === 'mark');
      assert.ok(mark);
      ms.push(mark);
      ms.push(mark);
      await flush();
      assert.equal(s.requests.length, 2);
      assert.equal(s.manager.public().completion!.playbackConfirmed, true);
      hook(s.manager, 'call.hangup');
      assert.equal(s.manager.public().status, 'ended');
      assert.ok(s.manager.public().endedAt! - s.manager.public().answeredAt! < 60000);
      const restored = new CallManager(s.store, s.dir);
      assert.equal(restored.outcomeStore.list()[0].completion.kind, kind);
      restored.dispose();
    } finally {
      s.cleanup();
      t.mock.timers.reset();
    }
  }
});
test('발화 전 짧은 답 문맥은 공백이며 낡은 비동기 분류·분류 오류는 구조 판단이 아니다', async (t) => {
  const s = setup();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    await s.manager.start(params);
    media(s.manager);
    hook(s.manager, 'call.answered');
    t.mock.timers.tick(2000);
    s.manager.current.questionSpoken = false;
    let resolve!: (value: ResidentAnswer) => void;
    s.manager.current.assess = async (_c, _text, _a, question) => {
      assert.equal(question, '');
      return new Promise((r) => (resolve = r));
    };
    user(s.sockets[0], '네');
    t.mock.timers.tick(180);
    await flush();
    user(s.sockets[0], '아니, 차가 없어요');
    resolve(facts('네', { mobility: 'possible', condition: 'comfortable' }));
    await flush();
    assert.equal(s.manager.public().assessment!.mobility, 'unknown');
    s.manager.current.assess = async () => {
      throw new Error('API failed');
    };
    t.mock.timers.tick(180);
    await flush();
    assert.equal(s.manager.public().completion, undefined);
    assert.equal(s.manager.public().assessment!.mobility, 'unknown');
    assert.equal(s.requests.length, 1);
  } finally {
    s.cleanup();
    t.mock.timers.reset();
  }
});
test('무응답 45초는 구조 대신 재확인, 무음 delta가 mark를 연기하지 않고 60초에 종료', async (t) => {
  const s = setup();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    await s.manager.start(params);
    t.mock.timers.tick(30000);
    const ms = media(s.manager);
    hook(s.manager, 'call.answered');
    t.mock.timers.tick(44999);
    assert.equal(s.manager.public().completion, undefined);
    t.mock.timers.tick(1);
    assert.equal(s.manager.public().completion!.kind, 'review');
    assert.match(s.manager.public().completion!.assessment!.reason, /45초.*再|45초.*재확인/);
    output(s.sockets[0], reviewFarewell, 320);
    for (let i = 0; i < 100; i++) {
      s.sockets[0].push({
        type: 'session.output_audio.delta',
        delta: Buffer.alloc(160, 254).toString('base64'),
      });
      t.mock.timers.tick(20);
      s.manager.current.bridge!.tick();
    }
    assert.ok(ms.sent.some((e) => e.event === 'mark'));
    // No playback acknowledgment: the 60-second deadline still sends one hangup.
    t.mock.timers.tick(13000);
    await flush();
    assert.equal(s.requests.length, 2);
    assert.equal(s.manager.public().completion!.playbackConfirmed, false);
    assert.equal(s.manager.public().status, 'ending');
  } finally {
    s.cleanup();
    t.mock.timers.reset();
  }
});
test('client 위임 ID 유지·저장 실패 시 종료 안내 없음', async (t) => {
  const s = setup();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    await s.manager.start(params);
    media(s.manager);
    hook(s.manager, 'call.answered');
    t.mock.timers.tick(2000);
    s.sockets[0].push({
      type: 'session.delegation.created',
      delegation: { id: 'del-original', target: 'client' },
    });
    assert.ok(
      s.sockets[0].sent.some(
        (e) => e.type === 'session.thinking.append' && e.delegation_id === 'del-original',
      ),
    );
    s.manager.outcomeStore.save = () => {
      throw new Error('disk failed');
    };
    s.manager.finishAssessment(s.manager.current, true);
    assert.equal(s.manager.public().completion, undefined);
    assert.ok(!s.sockets[0].sent.some((e) => e.content?.includes(reviewFarewell)));
  } finally {
    s.cleanup();
    t.mock.timers.reset();
  }
});
test('구조·대피 거부·재확인 후속 요청은 최종 종료 후 1회, 재시작 복원·대피 완료로 처리 안 함', () => {
  for (const [values, status] of [
    [{ mobility: 'needs_help' }, 'needs_assignment'],
    [{ refusal: 'refused' }, 'elder_contact_requested'],
    [{ condition: 'comfortable' }, 'review_requested'],
  ] as const) {
    const s = setup();
    try {
      const engine = new DisasterEngine(process.cwd(), s.dir, s.store);
      engine.command('watch');
      engine.command('propose');
      engine.command('approve', { approved: true });
      const h = engine.state.households.find((h) => h.callEligible && h.consentToCall)!;
      const linked = engine.prepare({ targetId: h.id });
      engine.bind(linked.id, 'live-test', 'telnyx');
      const a = residentAssessment();
      apply(a, '집이야', { location: '집' });
      apply(a, '응답 원문', values);
      const outcome = {
        callId: crypto.randomUUID(),
        sessionId: 'live-test',
        phone: '01000000000',
        scenario: 'resident' as const,
        completion: {
          ...finishResident(a),
          targetId: h.id,
          scenarioCallId: linked.id,
          status: 'reported' as const,
          recordedAt: Date.now(),
          playbackConfirmed: true,
        },
        callStatus: 'ending',
        endedAt: null as number | null,
      };
      engine.afterCall(outcome);
      assert.equal(engine.state.followUps.length, 0);
      outcome.callStatus = 'ended';
      outcome.endedAt = Date.now();
      engine.afterCall(outcome);
      engine.afterCall(outcome);
      assert.equal(engine.state.followUps.length, 1);
      assert.notEqual(h.status, 'safe');
      assert.equal(engine.state.dispatches.length, 0);
      const restored = new DisasterEngine(process.cwd(), s.dir, s.store);
      restored.afterCall(outcome);
      assert.equal(restored.state.followUps.length, 1);
      assert.equal(restored.state.followUps[0].status, status);
      assert.equal(
        restored.phoneShelter(h.id),
        restored.state.shelters.find((v) => v.id === h.shelterId)!.name,
      );
      restored.state.shelters.find((v) => v.id === h.shelterId)!.open = false;
      assert.throws(() => restored.phoneShelter(h.id), /열린 대피소/);
    } finally {
      s.cleanup();
    }
  }
});
