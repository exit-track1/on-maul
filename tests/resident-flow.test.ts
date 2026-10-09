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
test('지연된 전사 조각은 분류 중에도 앞 문장을 보존하고 한 번씩 분류해 구조 안내로 끝낸다', async (t) => {
  const s = setup();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    await s.manager.start(params);
    media(s.manager);
    hook(s.manager, 'call.answered');
    t.mock.timers.tick(2000);
    const classified: string[] = [];
    let resolveFirst!: (answer: ResidentAnswer) => void;
    s.manager.current.assess = async (_config, text) => {
      classified.push(text);
      if (classified.length === 1) return new Promise((resolve) => (resolveFirst = resolve));
      return facts(text, { mobility: 'needs_help', condition: 'uncomfortable' });
    };
    user(s.sockets[0], '집에 있는데요, 다리가 너무 움직이지');
    t.mock.timers.tick(180);
    await flush();
    user(s.sockets[0], ' 않아요');
    t.mock.timers.tick(180);
    await flush();
    assert.equal(classified.length, 1, '기존 분류가 끝날 때까지 병렬 분류를 시작하지 않는다');
    resolveFirst(unknownResidentAnswer());
    await flush();
    t.mock.timers.tick(40);
    await flush();
    assert.deepEqual(classified, [
      '집에 있는데요, 다리가 너무 움직이지',
      '집에 있는데요, 다리가 너무 움직이지 않아요',
    ]);
    assert.equal(s.manager.public().completion!.kind, 'rescue');
    assert.equal(s.manager.public().completion!.closingText, rescueFarewell);
    assert.equal(s.manager.public().assessment!.answers[0].text, classified[1]);
    assert.equal(s.sockets[0].sent.filter((e) => e.content?.includes('현재 산불로')).length, 1);
  } finally {
    s.cleanup();
    t.mock.timers.reset();
  }
});
test('대화 대기 중 Live 무음은 첫 질문 음성 뒤에 누적되지 않는다', async (t) => {
  const s = setup();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    await s.manager.start(params);
    media(s.manager);
    hook(s.manager, 'call.answered');
    t.mock.timers.tick(2000);
    const before = s.manager.current.bridge!.output.length;
    for (let i = 0; i < 100; i++) {
      s.sockets[0].push({
        type: 'session.output_audio.delta',
        delta: Buffer.alloc(160, 255).toString('base64'),
      });
      t.mock.timers.tick(20);
    }
    assert.equal(s.manager.current.bridge!.output.length, before);
    s.sockets[0].push({
      type: 'session.output_audio.delta',
      delta: Buffer.alloc(160, 0).toString('base64'),
    });
    for (let i = 0; i < 30; i++) {
      t.mock.timers.tick(20);
      s.sockets[0].push({
        type: 'session.output_audio.delta',
        delta: Buffer.alloc(160, 255).toString('base64'),
      });
    }
    assert.equal(
      s.manager.current.bridge!.output.length,
      before + 160 + 15 * 160,
      '발화 후 300ms의 자연스러운 무음만 보존한다',
    );
  } finally {
    s.cleanup();
    t.mock.timers.reset();
  }
});
test('180ms·900ms 비교: 같은 전체 전사와 낮은 신뢰도에서는 첫 안내 대신 차량 지원을 한 번 확인한다', async (t) => {
  const results: { delay: number; classified: string; openingCount: number }[] = [];
  for (const delay of [180, 900]) {
    const s = setup();
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    try {
      await s.manager.start(params);
      media(s.manager);
      hook(s.manager, 'call.answered');
      t.mock.timers.tick(2000);
      const after = s.manager.after.bind(s.manager);
      t.mock.method(
        s.manager,
        'after',
        (run: Parameters<CallManager['after']>[0], ms: number, callback: () => void) =>
          after(run, ms === 180 ? delay : ms, callback),
      );
      const text = '어 나 지금 모둠지겨요. 차 보내주실 수 있나요';
      let classified = '';
      s.manager.current.assess = async (_config, value) => {
        classified = value;
        return facts(value, { mobility: 'needs_help', confidence: 0.8 });
      };
      user(s.sockets[0], text);
      t.mock.timers.tick(delay - 1);
      await flush();
      assert.equal(classified, '');
      t.mock.timers.tick(1);
      await flush();
      assert.equal(classified, text);
      assert.equal(s.manager.public().assessment!.mobility, 'unknown');
      const openingCount = s.sockets[0].sent.filter((e) =>
        e.content?.includes('현재 산불로'),
      ).length;
      results.push({ delay, classified, openingCount });
      assert.equal(openingCount, 1);
      assert.equal(s.manager.current.questionLine, residentQuestions.assistance);
      assert.equal(s.manager.public().completion, undefined);
    } finally {
      s.cleanup();
      t.mock.restoreAll();
      t.mock.timers.reset();
    }
  }
  assert.equal(results[0].classified, results[1].classified);
  console.log(JSON.stringify({ experiment: 'same_transcript_and_model_result', results }));
});
test('차량 지원 확인 중 응답하세요 전사 조각은 질문을 다시 시작하지 않으며 네는 구조로 마친다', async (t) => {
  const s = setup();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    await s.manager.start(params);
    media(s.manager);
    hook(s.manager, 'call.answered');
    t.mock.timers.tick(2000);
    s.manager.current.assess = async (_config, text) =>
      facts(text, { mobility: 'needs_help', confidence: 0.8 });
    user(s.sockets[0], '모둠지겨요. 차 보내주실 수 있나요');
    t.mock.timers.tick(180);
    await flush();
    assert.equal(s.manager.current.questionLine, residentQuestions.assistance);
    const count = s.sockets[0].sent.filter((e) => e.type === 'session.instructions.append').length;
    s.manager.current.assess = async () => unknownResidentAnswer();
    for (const fragment of ['응답', '하세요']) {
      user(s.sockets[0], fragment);
      t.mock.timers.tick(180);
      await flush();
      assert.equal(
        s.sockets[0].sent.filter((e) => e.type === 'session.instructions.append').length,
        count,
      );
    }
    output(s.sockets[0], residentQuestions.assistance);
    s.manager.current.assess = async (_config, text, _assessment, question) => {
      assert.equal(question, residentQuestions.assistance);
      return facts(text, { mobility: 'needs_help' });
    };
    user(s.sockets[0], '네');
    t.mock.timers.tick(180);
    await flush();
    assert.equal(s.manager.public().completion!.kind, 'rescue');
    assert.equal(s.sockets[0].sent.filter((e) => e.content?.includes('현재 산불로')).length, 1);
    assert.equal(
      s.sockets[0].sent.filter((e) => e.content?.includes(residentQuestions.assistance)).length,
      1,
    );
  } finally {
    s.cleanup();
    t.mock.timers.reset();
  }
});
test('확인 질문에도 계속 불명확하면 첫 안내나 이전 질문을 반복하지 않고 담당자 재확인으로 끝낸다', async (t) => {
  const s = setup();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    await s.manager.start(params);
    media(s.manager);
    hook(s.manager, 'call.answered');
    t.mock.timers.tick(2000);
    s.manager.current.assess = async () => unknownResidentAnswer();
    for (const text of ['어디인지 잘 모르겠어요', '잘 모르겠는데요', '무슨 말인지 모르겠어요']) {
      output(s.sockets[0], s.manager.current.questionLine);
      user(s.sockets[0], text);
      t.mock.timers.tick(180);
      await flush();
    }
    assert.equal(s.manager.public().completion!.kind, 'review');
    assert.equal(s.sockets[0].sent.filter((e) => e.content?.includes('현재 산불로')).length, 1);
    assert.equal(
      s.sockets[0].sent.filter((e) => e.content?.includes(residentQuestions.assistance)).length,
      1,
    );
    assert.equal(
      s.sockets[0].sent.filter((e) => e.content?.includes(residentQuestions.independentMobility))
        .length,
      1,
    );
  } finally {
    s.cleanup();
    t.mock.timers.reset();
  }
});
test('수신자가 다시 말하기 시작하면 이전 분류를 반영하지 않고 전사 도착 후 루프를 이어간다', async (t) => {
  const s = setup();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    await s.manager.start(params);
    media(s.manager);
    hook(s.manager, 'call.answered');
    t.mock.timers.tick(2000);
    let resolveFirst!: (answer: ResidentAnswer) => void;
    const classified: string[] = [];
    s.manager.current.assess = async (_config, text) => {
      classified.push(text);
      if (classified.length === 1) return new Promise((r) => (resolveFirst = r));
      return facts(text, { mobility: 'needs_help' });
    };
    user(s.sockets[0], '차가 없어서');
    t.mock.timers.tick(180);
    await flush();
    const bridge = s.manager.current.bridge!;
    bridge.input(1, Buffer.alloc(480, 0).toString('base64'));
    for (let i = 0; i < 3; i++) bridge.tick(Date.now() + 40 + i * 20);
    assert.equal(bridge.inputSpeaking, true);
    resolveFirst(facts('차가 없어서', { mobility: 'needs_help' }));
    await flush();
    t.mock.timers.tick(40);
    assert.equal(s.manager.public().completion, undefined);
    assert.equal(classified.length, 1);
    user(s.sockets[0], ' 혼자 이동할 수 없어요');
    for (let i = 0; i < 8; i++) bridge.tick(Date.now() + 100 + i * 20);
    assert.equal(bridge.inputSpeaking, false);
    t.mock.timers.tick(180);
    await flush();
    assert.deepEqual(classified, ['차가 없어서', '차가 없어서 혼자 이동할 수 없어요']);
    assert.equal(s.manager.public().completion!.kind, 'rescue');
  } finally {
    s.cleanup();
    t.mock.timers.reset();
  }
});
test('미디어 stop·close 직후 정상 최종 종료는 연결 오류가 아니며 종료 미확인은 잠금을 유지한다', async (t) => {
  for (const confirmed of [true, false]) {
    const s = setup();
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    try {
      await s.manager.start(params);
      const socket = media(s.manager);
      hook(s.manager, 'call.answered');
      t.mock.timers.tick(2000);
      socket.push({ event: 'stop' });
      socket.close();
      assert.equal(s.manager.public().error, null);
      assert.equal(s.manager.public().blocked, true);
      t.mock.timers.tick(300);
      if (confirmed)
        hook(s.manager, 'call.hangup', 'normal-end', { hangup_cause: 'normal_clearing' });
      t.mock.timers.tick(1700);
      await flush();
      if (confirmed) {
        assert.equal(s.manager.public().status, 'ended');
        assert.equal(s.manager.public().error, null);
        assert.equal(s.requests.length, 1);
      } else {
        assert.equal(s.manager.public().error!.code, 'media_stream_stopped');
        assert.equal(s.manager.public().blocked, true);
        assert.equal(s.requests.length, 2);
      }
    } finally {
      s.cleanup();
      t.mock.timers.reset();
    }
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
