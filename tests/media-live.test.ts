import test from 'node:test';
import assert from 'node:assert/strict';
import type WebSocket from 'ws';
import { LiveConnection } from '../src/live.ts';
import { AudioBridge, muLawRms } from '../src/media.ts';
import { defaults } from '../src/config.ts';
import { FakeSocket, flush } from './helpers.ts';
async function ready() {
  const socket = new FakeSocket(),
    live = new LiveConnection(defaults, 'resident', () => {
      queueMicrotask(() => socket.emit('open'));
      return socket as unknown as WebSocket;
    });
  live.on('fault', () => {});
  await live.waitReady();
  return { socket, live };
}
test('4초 응답 재개는 최신 입력 조각부터 한 번, 정상 답변·종료·완료 안내는 취소', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = await ready();
  try {
    s.live.greet('resident');
    const baseline = s.socket.sent.filter((e) => e.type === 'session.instructions.append').length;
    s.socket.push({ type: 'session.input_transcript.delta', delta: '네' });
    t.mock.timers.tick(3000);
    s.socket.push({ type: 'session.input_transcript.delta', delta: '. 이해했어요' });
    t.mock.timers.tick(3999);
    assert.equal(
      s.socket.sent.filter((e) => e.type === 'session.instructions.append').length,
      baseline,
    );
    s.socket.push({
      type: 'session.output_audio.delta',
      delta: Buffer.alloc(160, 255).toString('base64'),
    });
    t.mock.timers.tick(1);
    assert.equal(
      s.socket.sent.filter((e) => e.type === 'session.instructions.append').length,
      baseline + 1,
    );
    t.mock.timers.tick(20000);
    assert.equal(
      s.socket.sent.filter((e) => e.type === 'session.instructions.append').length,
      baseline + 1,
    );
    s.socket.push({ type: 'session.input_transcript.delta', delta: '집이에요' });
    s.socket.push({ type: 'session.output_transcript.delta', delta: '도움이 필요하신가요?' });
    t.mock.timers.tick(5000);
    assert.equal(
      s.socket.sent.filter((e) => e.type === 'session.instructions.append').length,
      baseline + 1,
    );
    s.live.conclude();
    const count = s.socket.sent.length;
    s.socket.push({ type: 'session.input_transcript.delta', delta: '네' });
    t.mock.timers.tick(5000);
    assert.equal(s.socket.sent.length, count);
    s.live.close();
    t.mock.timers.tick(10000);
  } finally {
    s.live.dispose();
    t.mock.timers.reset();
  }
});
test('jitter chunk 순서·중복·20ms 무음·잡음은 clear하지 않으며 출력 10초 제한', async () => {
  const s = await ready(),
    socket = new FakeSocket();
  let fault = '';
  const bridge = new AudioBridge(
    socket as unknown as WebSocket,
    s.live,
    (code) => (fault = code),
    () => {},
    () => {},
  );
  bridge.active = true;
  try {
    bridge.input(2, Buffer.alloc(160, 254).toString('base64'));
    bridge.input(1, Buffer.alloc(160, 255).toString('base64'));
    bridge.input(1, Buffer.alloc(160, 0).toString('base64'));
    bridge.tick(Date.now() + 50);
    bridge.tick(Date.now() + 70);
    const frames = s.socket.sent.filter((e) => e.type === 'session.input_audio.append');
    assert.equal(Buffer.from(frames[0].audio, 'base64')[0], 255);
    assert.equal(Buffer.from(frames[1].audio, 'base64')[0], 254);
    bridge.tick(Date.now() + 90);
    assert.equal(Buffer.from(s.socket.sent.at(-1).audio, 'base64').length, 160);
    assert.equal(muLawRms(Buffer.from(s.socket.sent.at(-1).audio, 'base64')), 0);
    bridge.input(3, Buffer.alloc(480, 0).toString('base64'));
    bridge.appendOutput(Buffer.alloc(1000, 0).toString('base64'));
    bridge.tick(Date.now() + 110);
    bridge.tick(Date.now() + 130);
    bridge.tick(Date.now() + 150);
    assert.equal(bridge.clears, 0);
    bridge.clear();
    assert.ok(socket.sent.some((e) => e.event === 'clear'));
    bridge.appendOutput(Buffer.alloc(80000, 0).toString('base64'));
    bridge.appendOutput(Buffer.alloc(160, 0).toString('base64'));
    assert.equal(fault, 'media_output_overflow');
  } finally {
    bridge.dispose();
    s.live.dispose();
  }
});
test('입력 버퍼·backpressure 제한과 잘못된 audio 거절', async () => {
  for (const kind of ['input', 'output', 'socket'] as const) {
    const s = await ready(),
      socket = new FakeSocket();
    let fault = '';
    const bridge = new AudioBridge(
      socket as unknown as WebSocket,
      s.live,
      (code) => (fault = code),
      () => {},
      () => {},
    );
    bridge.active = true;
    try {
      bridge.input(0, 'not base64');
      assert.equal(bridge.pending.size, 0);
      if (kind === 'input') {
        bridge.input(0, Buffer.alloc(80000).toString('base64'));
        bridge.input(1, Buffer.alloc(160).toString('base64'));
        assert.equal(fault, 'media_input_overflow');
      } else if (kind === 'output') {
        bridge.appendOutput(Buffer.alloc(80000).toString('base64'));
        bridge.appendOutput(Buffer.alloc(160).toString('base64'));
        assert.equal(fault, 'media_output_overflow');
      } else {
        socket.bufferedAmount = 80001;
        bridge.appendOutput(Buffer.alloc(160).toString('base64'));
        bridge.tick(Date.now() + 120);
        assert.equal(fault, 'media_backpressure');
      }
    } finally {
      bridge.dispose();
      s.live.dispose();
    }
  }
  await flush();
});
test('출력은 120ms 버퍼와 60ms 패킷으로 원문 순서를 보존하고 짧은 조각에 무음을 끼우지 않음', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const s = await ready(),
    socket = new FakeSocket();
  const bridge = new AudioBridge(
    socket as unknown as WebSocket,
    s.live,
    () => {},
    () => {},
    () => {},
  );
  bridge.active = true;
  try {
    const audio = Buffer.from(Array.from({ length: 1280 }, (_, i) => i % 256));
    bridge.appendOutput(audio.subarray(0, 73).toString('base64'));
    bridge.tick();
    assert.equal(socket.sent.filter((e) => e.event === 'media').length, 0);
    bridge.appendOutput(audio.subarray(73, 319).toString('base64'));
    bridge.tick(Date.now() + 80);
    assert.equal(socket.sent.filter((e) => e.event === 'media').length, 0);
    bridge.appendOutput(audio.subarray(319).toString('base64'));
    const now = Date.now();
    bridge.tick(now + 100);
    bridge.tick(now + 120);
    assert.equal(socket.sent.filter((e) => e.event === 'media').length, 1);
    bridge.tick(now + 160);
    bridge.tick(now + 220);
    const packets = socket.sent
      .filter((e) => e.event === 'media')
      .map((e) => Buffer.from(e.media.payload, 'base64'));
    assert.deepEqual(
      packets.map((p) => p.length),
      [480, 480, 320],
    );
    assert.deepEqual(Buffer.concat(packets), audio);
    assert.equal(bridge.outputBytes, audio.length);
    assert.equal(bridge.clears, 0);
  } finally {
    bridge.dispose();
    s.live.dispose();
    t.mock.timers.reset();
  }
});
