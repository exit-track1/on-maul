import test from 'node:test';
import assert from 'node:assert/strict';
import { CallManager } from '../src/calls.ts';
import { DisasterEngine } from '../src/disaster.ts';
import {
  advanceResident,
  finishResident,
  residentAssessment,
  residentQuestions,
  rescueFarewell,
} from '../src/resident-flow.ts';
import { setup, params, media, hook, user, output, flush } from './helpers.ts';

test('집 → 어디로 가야 돼 → 괜찮아: 모호한 이동 답은 구조 요청이며 안전 완료가 아니다', () => {
  const a = residentAssessment();
  advanceResident(a, '어 나 지금 집이야');
  assert.equal(a.location, '집');
  advanceResident(a, '어 어디로 가야 돼?');
  assert.equal(a.mobility, 'unknown');
  advanceResident(a, '나는 괜찮아');
  const result = finishResident(a);
  assert.equal(result.kind, 'rescue');
  assert.equal(result.closingText, rescueFarewell);
  assert.equal(a.condition, 'comfortable');
  assert.equal(result.assessment.reason, '이동 가능 여부 미확인');
});
test('명확한 이동 가능·건강 응답만 이동 신고, 부정·도움·질문은 구조 확인', () => {
  for (const [mobility, condition, kind] of [
    ['네', '불편한 곳은 없어요', 'moving'],
    ['혼자 걸어 갈 수 있어요', '괜찮아요', 'moving'],
    ['이동 가능하지 않아요', '괜찮아요', 'rescue'],
    ['갈 수가 없어요', '괜찮아요', 'rescue'],
    ['네', '괜찮지 않아요', 'rescue'],
    ['가능해요', '몸은 괜찮지만 숨이 차요', 'rescue'],
    ['어디로 가야 하나요', '네', 'rescue'],
  ]) {
    const a = residentAssessment();
    advanceResident(a, '집이에요');
    advanceResident(a, mobility);
    advanceResident(a, condition);
    assert.equal(finishResident(a).kind, kind, mobility + ' / ' + condition);
  }
});
test('세 질문은 앱에서 진행, 테스트 안내·추가 위임 없이 저장 후 재생 mark와 최종 종료', async (t) => {
  const s = setup();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    await s.manager.start(params);
    const ms = media(s.manager);
    hook(s.manager, 'call.answered');
    const socket = s.sockets[0];
    assert.deepEqual(socket.sent[0].session.delegation, { type: 'client' });
    for (const text of ['어 나 지금 집이야', '어 어디로 가야 돼?', '나는 괜찮아']) {
      user(socket, text);
      t.mock.timers.tick(900);
      await flush();
    }
    const instructions = socket.sent
      .filter((e) => e.type === 'session.instructions.append')
      .map((e) => e.content)
      .join('\n');
    for (const line of Object.values(residentQuestions)) assert.ok(instructions.includes(line));
    assert.ok(!/AI 테스트 전화|안내라는 점을 이해/.test(instructions));
    const outcome = s.manager.outcomeStore.list()[0];
    assert.equal(outcome.completion.kind, 'rescue');
    assert.equal(outcome.completion.location, '집');
    assert.equal(s.requests.length, 1);
    output(socket, rescueFarewell, 1280);
    t.mock.timers.tick(1500);
    const now = Date.now();
    for (let i = 0; i < 4; i++) s.manager.current.bridge!.tick(now + i * 60);
    const mark = ms.sent.find((e) => e.event === 'mark');
    assert.ok(mark);
    ms.push(mark);
    await flush();
    assert.equal(s.requests.length, 2);
    assert.equal(s.manager.public().completion!.playbackConfirmed, true);
    assert.equal(s.manager.public().status, 'ending');
    hook(s.manager, 'call.hangup');
    assert.equal(s.manager.public().status, 'ended');
    assert.ok(s.manager.public().endedAt! - s.manager.public().answeredAt! < 60000);
    const restored = new CallManager(s.store, s.dir);
    assert.equal(restored.outcomeStore.list()[0].completion.kind, 'rescue');
    restored.dispose();
  } finally {
    s.cleanup();
    t.mock.timers.reset();
  }
});
test('연속 Live 무음 delta는 종료 mark를 무한 연기하지 않는다', async (t) => {
  const s = setup();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    await s.manager.start(params);
    const ms = media(s.manager);
    hook(s.manager, 'call.answered');
    s.manager.finishAssessment(s.manager.current, true);
    output(s.sockets[0], rescueFarewell, 320);
    for (let i = 0; i < 100; i++) {
      s.sockets[0].push({
        type: 'session.output_audio.delta',
        delta: Buffer.alloc(160, 254).toString('base64'),
      });
      t.mock.timers.tick(20);
      s.manager.current.bridge!.tick();
    }
    const mark = ms.sent.find((e) => e.event === 'mark');
    assert.ok(mark, 'silence does not reset the farewell timer');
    ms.push(mark);
    await flush();
    assert.equal(s.requests.length, 2);
  } finally {
    s.cleanup();
    t.mock.timers.reset();
  }
});
test('응답 이후 45초에 미확인 요청 저장, 재생 미확인은 60초 종료이며 벨소리 시간은 제외', async (t) => {
  const s = setup();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    await s.manager.start(params);
    t.mock.timers.tick(30000);
    media(s.manager);
    hook(s.manager, 'call.answered');
    t.mock.timers.tick(44999);
    assert.equal(s.manager.public().completion, undefined);
    t.mock.timers.tick(1);
    assert.equal(s.manager.public().completion!.kind, 'rescue');
    assert.equal(s.manager.public().completion!.assessment!.reason, '45초 내 확인 미완료');
    assert.equal(s.requests.length, 1);
    t.mock.timers.tick(15000);
    await flush();
    assert.equal(s.requests.length, 2);
    assert.equal(s.manager.public().completion!.playbackConfirmed, false);
    assert.equal(s.manager.public().status, 'ending');
    assert.equal(s.manager.public().blocked, true);
  } finally {
    s.cleanup();
    t.mock.timers.reset();
  }
});
test('client 위임은 원래 ID로 처리하며 구조 결과 저장 실패 시 종료 멘트 없음', async (t) => {
  const s = setup();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    await s.manager.start(params);
    media(s.manager);
    hook(s.manager, 'call.answered');
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
    assert.ok(!s.sockets[0].sent.some((e) => e.content?.includes(rescueFarewell)));
    assert.equal(s.requests.length, 1);
  } finally {
    s.cleanup();
    t.mock.timers.reset();
  }
});
test('구조 후속 요청은 최종 종료 후 1회 생성·재시작 복원, 대피 완료로 처리하지 않는다', async () => {
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
    advanceResident(a, '집이야');
    advanceResident(a, '어디로 가야 돼');
    advanceResident(a, '괜찮아');
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
    assert.equal(h.status, 'help');
    assert.equal(engine.state.dispatches.length, 0);
    const restored = new DisasterEngine(process.cwd(), s.dir, s.store);
    restored.afterCall(outcome);
    assert.equal(restored.state.followUps.length, 1);
    assert.equal(restored.state.followUps[0].status, 'needs_assignment');
  } finally {
    s.cleanup();
  }
});
