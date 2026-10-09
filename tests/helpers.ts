import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type WebSocket from 'ws';
import { ConfigStore } from '../src/config.ts';
import { CallManager } from '../src/calls.ts';
export class FakeSocket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  sent: any[] = [];
  autoStart = true;
  autoOpening = true;
  send(raw: string) {
    const event = JSON.parse(raw);
    this.sent.push(event);
    if (event.type === 'session.start' && this.autoStart)
      queueMicrotask(() => this.push({ type: 'session.started', session: { id: 'live_test' } }));
    if (event.type === 'session.close') queueMicrotask(() => this.push({ type: 'session.closed' }));
    if (event.type === 'session.instructions.append')
      queueMicrotask(() => {
        this.push({ type: 'session.instructions.appended', client_event_id: event.event_id });
        if (
          this.autoOpening &&
          (event.content.includes('현재 산불로 인하여 대피하셔야 합니다.') ||
            event.content.includes('가상의 구조 요청에 참여 가능하신가요?'))
        ) {
          this.autoOpening = false;
          this.push({
            type: 'session.output_transcript.delta',
            delta: event.content.match(/Say exactly this sentence in full: "([^"]+)"/)[1],
          });
          this.push({
            type: 'session.output_audio.delta',
            delta: Buffer.alloc(640, 0).toString('base64'),
          });
        }
      });
  }
  push(event: unknown) {
    this.emit('message', Buffer.from(JSON.stringify(event)));
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close');
  }
  terminate() {
    this.close();
  }
}
export const params = { scenario: 'resident', consent: true };
export const flush = () => new Promise<void>((r) => setImmediate(r));
export function setup(fetcher?: typeof fetch) {
  const dir = mkdtempSync(join(tmpdir(), 'onmaul-fresh-test-')),
    store = new ConfigStore(dir, {}),
    sockets: FakeSocket[] = [],
    requests: { url: string; body: any }[] = [];
  store.save({
    OPENAI_API_KEY: 'sk-test-only-placeholder',
    TELNYX_API_KEY: 'telnyx-test-only-placeholder',
    TELNYX_APPLICATION_ID: '123456789',
    TELNYX_PUBLIC_KEY: Buffer.alloc(32, 1).toString('base64'),
    PUBLIC_BASE_URL: 'https://fake-call.trycloudflare.com',
    CALLER_NUMBER: '+12025550103',
    TEST_PHONE: '01000000000',
  });
  const manager = new CallManager(store, dir, {
    fetcher:
      fetcher ??
      (async (url, options) => {
        if (String(url).includes('api.openai.com')) return Response.json({ status: 'incomplete' });
        requests.push({
          url: String(url),
          body: options?.body ? JSON.parse(String(options.body)) : null,
        });
        return Response.json({ data: { call_control_id: 'telnyx_test' } });
      }),
    socketFactory: () => {
      const s = new FakeSocket();
      sockets.push(s);
      queueMicrotask(() => s.emit('open'));
      return s as unknown as WebSocket;
    },
    requestTimeoutMs: 100,
  });
  return {
    dir,
    store,
    sockets,
    requests,
    manager,
    cleanup() {
      manager.dispose();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
export function hook(manager: CallManager, type: string, id = type, payload = {}) {
  manager.webhook({
    data: {
      id,
      event_type: type,
      payload: {
        call_control_id: 'telnyx_test',
        client_state: manager.current.clientState,
        to: '+821000000000',
        ...payload,
      },
    },
  });
}
export function media(manager: CallManager) {
  const socket = new FakeSocket();
  manager.attachMedia(socket as unknown as WebSocket);
  socket.push({
    event: 'start',
    start: {
      client_state: manager.current.clientState,
      call_control_id: 'telnyx_test',
      media_format: { encoding: 'PCMU', sample_rate: 8000, channels: 1 },
    },
  });
  return socket;
}
export function user(socket: FakeSocket, text: string) {
  socket.push({
    type: 'session.input_transcript.delta',
    delta: text,
    event_id: crypto.randomUUID(),
  });
}
export function output(socket: FakeSocket, text: string, audioBytes = 320) {
  socket.push({
    type: 'session.output_transcript.delta',
    delta: text,
    event_id: crypto.randomUUID(),
  });
  socket.push({
    type: 'session.output_audio.delta',
    delta: Buffer.alloc(audioBytes, 0).toString('base64'),
  });
}
