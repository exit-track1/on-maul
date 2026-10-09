import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CallManager } from '../src/calls.ts';
import { setup, params, media, hook, user, output, flush, FakeSocket } from './helpers.ts';
import type WebSocket from 'ws';
import { farewell } from '../src/domain.ts';
test('동의·저장번호·OpenAI 준비 실패는 발신 0회, 정상 payload 1회와 중복 잠금', async () => {
  const s = setup();
  try {
    await assert.rejects(s.manager.start({ ...params, consent: false }));
    await assert.rejects(s.manager.start({ ...params, phone: '01011111111' }));
    assert.equal(s.requests.length, 0);
    await s.manager.start(params);
    await assert.rejects(s.manager.start(params));
    assert.equal(s.requests.length, 1);
    const p = s.requests[0].body;
    assert.equal(p.retry_on_timeout, false);
    assert.equal(p.time_limit_secs, 240);
    assert.equal(p.stream_codec, 'PCMU');
    assert.equal(p.stream_track, 'inbound_track');
    assert.equal(p.stream_bidirectional_mode, 'rtp');
    assert.equal(p.to, '+821000000000');
    assert.ok(p.command_id);
    assert.ok(p.client_state);
    assert.match(p.stream_url, /\/media\/[a-f0-9]{64}$/);
    const event = s.sockets[0].sent[0];
    assert.equal(event.session.model, 'gpt-live-1');
    assert.equal(event.session.store, false);
    assert.deepEqual(event.session.delegation, { type: 'client' });
  } finally {
    s.cleanup();
  }
  const fail = setup();
  try {
    fail.manager.factory = () => {
      const socket = new FakeSocket();
      socket.autoStart = false;
      queueMicrotask(() =>
        socket.push({ type: 'error', error: { code: 'model_denied', message: 'denied' } }),
      );
      return socket as unknown as WebSocket;
    };
    await fail.manager.start(params);
    assert.equal(fail.requests.length, 0);
    assert.equal(fail.manager.public().status, 'failed');
  } finally {
    fail.cleanup();
  }
});
test('발신 접수·벨소리·수신·미디어를 구분하며 수신 전에 안내하지 않고 연속 무음 유지', async (t) => {
  const s = setup();
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  try {
    await s.manager.start(params);
    assert.equal(s.manager.public().status, 'created');
    t.mock.timers.tick(40);
    assert.equal(
      s.sockets[0].sent.filter((e) => e.type === 'session.input_audio.append').length,
      2,
    );
    assert.equal(s.manager.current.openingReady, true);
    assert.equal(s.manager.public().transcript.length, 0);
    const ms = media(s.manager);
    t.mock.timers.tick(20000);
    assert.equal(s.manager.public().blocked, true);
    assert.equal(s.manager.current.bridge?.active, false);
    hook(s.manager, 'call.initiated', 'ring', { state: 'ringing' });
    assert.equal(s.manager.public().status, 'ringing');
    hook(s.manager, 'call.answered');
    t.mock.timers.tick(2000);
    hook(s.manager, 'call.answered');
    t.mock.timers.tick(2000);
    assert.equal(s.manager.current.bridge?.active, true);
    assert.equal(
      s.sockets[0].sent.filter((e) => e.type === 'session.instructions.append').length,
      1,
    );
    assert.match(
      s.sockets[0].sent.find((e) => e.type === 'session.instructions.append').content,
      /현재 산불로 인하여 대피하셔야 합니다/,
    );
    hook(s.manager, 'call.initiated', 'late');
    assert.equal(s.manager.public().status, 'answered');
    assert.equal(s.manager.current.silenceTimer, undefined);
    assert.ok(ms.sent.some((e) => e.event === 'media'));
  } finally {
    s.cleanup();
    t.mock.timers.reset();
  }
});
test('수신 전과 첫 안내 2초 대기에도 실제 입력 패킷을 소비하고 입력 펌프는 하나만 실행한다', async (t) => {
  const s = setup();
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  try {
    await s.manager.start(params);
    const socket = media(s.manager);
    const input = Buffer.alloc(160, 254).toString('base64');
    for (let i = 0; i < 125; i++) {
      if (i === 25) hook(s.manager, 'call.answered');
      socket.push({ event: 'media', media: { track: 'inbound', chunk: i + 1, payload: input } });
      assert.equal(socket.sent.filter((e) => e.event === 'media').length, 0);
      t.mock.timers.tick(20);
      assert.equal(s.manager.public().blocked, true);
      assert.equal(s.manager.public().error, null);
    }
    const frames = s.sockets[0].sent.filter((e) => e.type === 'session.input_audio.append');
    assert.equal(frames.length, 125, '수신 전 무음 펌프와 미디어 펌프가 중복되지 않는다');
    assert.ok(frames.some((e) => e.audio === input));
    assert.equal(s.manager.current.bridge!.active, true);
    assert.equal(s.manager.current.silenceTimer, undefined);
    assert.equal(s.manager.public().events.filter((e) => e.type === 'opening_playback').length, 1);
    t.mock.timers.tick(200);
    assert.equal(s.manager.current.bridge!.pending.size, 0);
    assert.equal(s.manager.current.bridge!.inputQueue.length, 0);
    assert.equal(s.manager.current.bridge!.inputBytes, 125 * 160);
    assert.ok(socket.sent.some((e) => e.event === 'media'));
    assert.equal(s.requests.length, 1);
  } finally {
    s.cleanup();
    t.mock.timers.reset();
  }
});
test('완료 저장 → 오디오 큐 → 고유 mark → 1회 hangup → 서명된 최종 종료와 복원', async (t) => {
  const s = setup();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    await s.manager.start(params);
    const ms = media(s.manager);
    hook(s.manager, 'call.answered');
    t.mock.timers.tick(2000);
    s.manager.current.classify = async (_c, text) => ({ location: '학교', evidence: text });
    user(s.sockets[0], '학교에 도착했어요');
    t.mock.timers.tick(1500);
    await flush();
    assert.equal(s.manager.outcomeStore.list()[0].completion.evidence, '학교에 도착했어요');
    assert.equal(s.requests.length, 1);
    assert.equal(
      statSync(join(s.dir, 'call-outcomes', s.manager.public().id + '.json')).mode & 0o777,
      0o600,
    );
    output(s.sockets[0], farewell, 640);
    t.mock.timers.tick(1500);
    s.manager.current.bridge!.tick();
    assert.ok(!ms.sent.some((e) => e.event === 'mark'));
    s.manager.current.bridge!.tick(Date.now() + 60);
    const mark = ms.sent.find((e) => e.event === 'mark');
    assert.ok(mark);
    ms.push(mark);
    await flush();
    assert.equal(s.requests.length, 2);
    assert.equal(s.manager.public().status, 'ending');
    assert.equal(s.manager.public().blocked, true);
    assert.equal(s.manager.public().completion?.playbackConfirmed, true);
    ms.push(mark);
    await s.manager.stop();
    assert.equal(s.requests.length, 2);
    hook(s.manager, 'call.hangup');
    assert.equal(s.manager.public().status, 'ended');
    assert.equal(s.manager.public().blocked, false);
    const restored = new CallManager(s.store, s.dir);
    assert.equal(restored.outcomeStore.list()[0].callStatus, 'ended');
    assert.equal(restored.public().completion?.playbackConfirmed, true);
    restored.dispose();
    assert.ok(!readFileSync(s.manager.journal, 'utf8').includes('transcript'));
  } finally {
    s.cleanup();
    t.mock.timers.reset();
  }
});
test('전사만 있고 실제 출력 오디오가 없으면 mark 확인으로 끊지 않음', async (t) => {
  const s = setup();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    await s.manager.start(params);
    const ms = media(s.manager);
    hook(s.manager, 'call.answered');
    t.mock.timers.tick(2000);
    s.manager.complete(s.manager.current, { location: '학교', evidence: '신고' });
    s.sockets[0].push({ type: 'session.output_transcript.delta', delta: farewell });
    t.mock.timers.tick(1500);
    s.manager.current.bridge!.tick();
    assert.equal(s.manager.current.mark, undefined);
    assert.ok(!ms.sent.some((e) => e.event === 'mark'));
    assert.equal(s.requests.length, 1);
  } finally {
    s.cleanup();
    t.mock.timers.reset();
  }
});
test('clear로 돌아온 mark와 정정 발화는 재생 성공이 아니며 needs_review 보존', async (t) => {
  const s = setup();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    await s.manager.start(params);
    const ms = media(s.manager);
    hook(s.manager, 'call.answered');
    t.mock.timers.tick(2000);
    s.manager.complete(s.manager.current, { location: '학교', evidence: '학교에 도착' });
    output(s.sockets[0], farewell, 160);
    t.mock.timers.tick(1500);
    s.manager.current.bridge!.tick();
    const mark = ms.sent.find((e) => e.event === 'mark');
    assert.ok(mark);
    s.manager.current.bridge!.clear();
    ms.push(mark);
    assert.equal(s.requests.length, 1);
    assert.equal(s.manager.public().completion?.playbackConfirmed, false);
    user(s.sockets[0], '잠깐, 잘못 말했어요');
    assert.equal(s.manager.public().completion?.status, 'needs_review');
    assert.match(s.manager.outcomeStore.list()[0].completion.correction ?? '', /잠깐/);
    t.mock.timers.tick(30000);
    await flush();
    assert.equal(s.requests.length, 1);
    assert.equal(s.manager.current.live?.concluding, false);
  } finally {
    s.cleanup();
    t.mock.timers.reset();
  }
});
test('낡은 비동기 분류 결과·분류 실패·저장 실패는 자동 종료하지 않음', async (t) => {
  const s = setup();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    await s.manager.start(params);
    media(s.manager);
    hook(s.manager, 'call.answered');
    t.mock.timers.tick(2000);
    let resolve!: (v: any) => void;
    s.manager.current.classify = async () => new Promise((r) => (resolve = r));
    user(s.sockets[0], '학교에 도착했어요');
    t.mock.timers.tick(1500);
    user(s.sockets[0], '아니요 아직 집이에요');
    resolve({ location: '학교', evidence: '학교에 도착했어요' });
    await flush();
    assert.equal(s.manager.public().completion, undefined);
    s.manager.current.classify = async () => {
      throw new Error('failed');
    };
    t.mock.timers.tick(1500);
    await flush();
    assert.equal(s.manager.public().completion, undefined);
    s.manager.outcomeStore.save = () => {
      throw new Error('disk failure');
    };
    s.manager.complete(s.manager.current, { location: '학교', evidence: '학교에 도착' });
    assert.equal(s.manager.public().completion, undefined);
    assert.ok(!s.sockets[0].sent.some((e) => /애플리케이션이 대피 완료/.test(e.content ?? '')));
    assert.equal(s.requests.length, 1);
  } finally {
    s.cleanup();
    t.mock.timers.reset();
  }
});
test('안내 재생 30초 누락 종료는 미확인으로 기록, 최종 이벤트 없으면 잠금 유지', async (t) => {
  const s = setup();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    await s.manager.start(params);
    media(s.manager);
    hook(s.manager, 'call.answered');
    t.mock.timers.tick(2000);
    s.manager.complete(s.manager.current, { location: '학교', evidence: '학교에 도착' });
    t.mock.timers.tick(30000);
    await flush();
    assert.equal(s.requests.length, 2);
    assert.equal(s.manager.public().completion?.playbackConfirmed, false);
    assert.equal(s.manager.public().status, 'ending');
    t.mock.timers.tick(12000);
    assert.equal(s.manager.public().status, 'unknown');
    assert.equal(s.manager.busy(), true);
    assert.throws(() => s.manager.resolveUnknown(false));
    s.manager.resolveUnknown(true);
    assert.equal(s.manager.busy(), false);
  } finally {
    s.cleanup();
    t.mock.timers.reset();
  }
});
test('발신 응답 대기 중 종료 의도와 5xx 불명 상태·재시작·늦은 ID 경쟁', async () => {
  let resolve!: (r: Response) => void,
    count = 0;
  const s = setup(async () => {
    count++;
    return count === 1 ? new Promise((r) => (resolve = r)) : Response.json({ data: {} });
  });
  try {
    const started = s.manager.start(params);
    await flush();
    await s.manager.stop();
    resolve(Response.json({ data: { call_control_id: 'telnyx_test' } }));
    await started;
    assert.equal(count, 2);
    assert.equal(s.manager.public().status, 'ending');
    hook(s.manager, 'call.hangup');
    assert.equal(s.manager.public().blocked, false);
  } finally {
    s.cleanup();
  }
  const unknown = setup(async () =>
    Response.json({ errors: [{ code: 'bad', title: 'failure' }] }, { status: 503 }),
  );
  try {
    await unknown.manager.start(params);
    assert.equal(unknown.manager.public().status, 'unknown');
    assert.equal(unknown.manager.busy(), true);
    await assert.rejects(unknown.manager.start(params));
    const restored = new CallManager(unknown.store, unknown.dir);
    assert.equal(restored.public().status, 'unknown');
    restored.dispose();
    hook(unknown.manager, 'call.hangup');
    assert.equal(unknown.manager.busy(), false);
  } finally {
    unknown.cleanup();
  }
});
test('media 시작 제한은 수신 후 12초, 전체 최대 시간은 발신 시작부터', async (t) => {
  const s = setup();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    await s.manager.start(params);
    t.mock.timers.tick(30000);
    assert.equal(s.requests.length, 1);
    hook(s.manager, 'call.answered');
    t.mock.timers.tick(11999);
    assert.equal(s.requests.length, 1);
    t.mock.timers.tick(1);
    await flush();
    assert.equal(s.requests.length, 2);
    hook(s.manager, 'call.hangup');
    s.store.value.MAX_CALL_SECONDS = 30;
    await s.manager.start(params);
    t.mock.timers.tick(30000);
    await flush();
    assert.equal(s.requests.length, 4);
    assert.equal(s.manager.public().status, 'ending');
  } finally {
    s.cleanup();
    t.mock.timers.reset();
  }
});
test('대기조 참여·이전 통화 이벤트·중복 전사는 주민 완료로 처리하지 않음', async (t) => {
  const s = setup();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    await s.manager.start({ ...params, scenario: 'standby' });
    media(s.manager);
    hook(s.manager, 'call.answered');
    t.mock.timers.tick(2000);
    let classified = 0;
    s.manager.current.classify = async () => {
      classified++;
      return null;
    };
    const event = {
      type: 'session.input_transcript.delta',
      delta: '대피소에 도착했어요',
      event_id: 'same-event',
    };
    s.sockets[0].push(event);
    s.sockets[0].push(event);
    t.mock.timers.tick(1500);
    assert.equal(classified, 0);
    assert.equal(
      s.manager.public().transcript.filter((t) => t.speaker === 'user')[0].text,
      event.delta,
    );
    const oldState = s.manager.current.clientState;
    hook(s.manager, 'call.hangup');
    await s.manager.start(params);
    hook(s.manager, 'call.answered', 'old', { client_state: oldState });
    assert.equal(s.manager.public().answerObserved, false);
  } finally {
    s.cleanup();
    t.mock.timers.reset();
  }
});
