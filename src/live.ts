import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type { Config } from './config.ts';
import { AppError, farewell, instructions, type Scenario } from './domain.ts';
import { residentQuestions } from './resident-flow.ts';
export type SocketFactory = (url: string, key: string) => WebSocket;
export const socketFactory: SocketFactory = (url, key) =>
  new WebSocket(url, {
    headers: { Authorization: `Bearer ${key}` },
    handshakeTimeout: 10000,
    maxPayload: 2 ** 21,
  });
export function sessionConfig(
  config: Config,
  scenario: Scenario,
  context = '',
  controlled = false,
) {
  const prompt =
    instructions(scenario, context) +
    (controlled
      ? '\nBackchannel policy: Do not add acknowledgments or listening sounds.\nInterruption policy: Listen when interrupted.\nDelegation policy: The app manages the workflow. When an app instruction arrives, immediately speak its specified Korean sentence, even if the caller has not spoken. After that sentence, listen until the next app instruction. Do not choose questions or conclusions yourself.'
      : '');
  return {
    model: config.LIVE_MODEL,
    store: false,
    instructions: prompt,
    audio: { format: { type: 'audio/pcmu', rate: 8000 }, output: { voice: config.VOICE } },
    delegation: controlled
      ? { type: 'client' }
      : {
          type: 'responses',
          responses: {
            model: config.BACKEND_MODEL,
            instructions: prompt,
            tools: [],
            tool_choice: 'none',
            max_output_tokens: 512,
          },
        },
  };
}
export class LiveConnection extends EventEmitter {
  socket: WebSocket;
  sessionId: string | null = null;
  closing = false;
  greetingSent = false;
  concluding = false;
  finalized = false;
  private replyTimer?: NodeJS.Timeout;
  private deadline?: NodeJS.Timeout;
  private seen = new Set<string>();
  private pendingInstructions = new Map<string, NodeJS.Timeout>();
  controlled: boolean;
  currentLine = '';
  constructor(
    config: Config,
    scenario: Scenario,
    factory: SocketFactory = socketFactory,
    context = '',
    sidebandId?: string,
    controlled = false,
  ) {
    super();
    this.controlled = controlled;
    this.socket = factory(
      'wss://api.openai.com/v1/live/sessions' +
        (sidebandId ? `/${encodeURIComponent(sidebandId)}/attach` : ''),
      config.OPENAI_API_KEY,
    );
    this.socket.once('open', () => {
      if (sidebandId) {
        this.sessionId = sidebandId;
        this.emit('ready', sidebandId);
      } else
        this.send({
          type: 'session.start',
          event_id: randomUUID(),
          session: sessionConfig(config, scenario, context, controlled),
        });
    });
    this.socket.on('message', (raw) => {
      let event: any;
      try {
        event = JSON.parse(raw.toString());
      } catch {
        this.emit('fault', new AppError('invalid_live_event', '음성 API 이벤트 형식 오류', 502));
        return;
      }
      if (typeof event.event_id === 'string') {
        if (this.seen.has(event.event_id)) return;
        this.seen.add(event.event_id);
        if (this.seen.size > 10000) this.seen.delete(this.seen.values().next().value!);
      }
      if (event.type === 'session.started' || event.type === 'session.attached') {
        const id = event.session?.id ?? event.session_id;
        if (typeof id !== 'string' || !id || (sidebandId && id !== sidebandId)) {
          this.emit('fault', new AppError('invalid_session_id', '음성 세션 ID 불일치', 502));
          return;
        }
        this.sessionId = id;
        this.emit('ready', id);
      }
      if (event.type === 'error')
        this.emit(
          'fault',
          new AppError(
            String(event.error?.code ?? 'live_error'),
            String(event.error?.message ?? '음성 API 오류'),
            502,
          ),
        );
      if (event.type === 'session.instructions.appended') {
        const id = event.client_event_id;
        if (typeof id === 'string' && this.pendingInstructions.has(id)) {
          clearTimeout(this.pendingInstructions.get(id));
          this.pendingInstructions.delete(id);
          this.emit('instruction-accepted', id);
        }
      }
      if (event.type === 'session.closed') {
        this.finalized = true;
        this.cancelReply();
        this.emit('finalized');
        this.socket.close();
      }
      if (
        !this.controlled &&
        event.type === 'session.input_transcript.delta' &&
        event.delta?.trim()
      )
        this.waitReply();
      if (
        this.controlled &&
        event.type === 'session.delegation.created' &&
        event.delegation?.target === 'client' &&
        typeof event.delegation.id === 'string'
      ) {
        this.send({
          type: 'session.thinking.append',
          event_id: randomUUID(),
          delegation_id: event.delegation.id,
          content:
            '앱이 통화 진행과 기록을 관리합니다. 추가 작업은 없습니다. 다음 앱 지시까지 듣고 기다리세요.',
        });
        this.emit('delegation-handled');
      }
      if (event.type === 'session.output_transcript.delta' && event.delta?.trim())
        this.cancelReply();
      this.emit('event', event);
    });
    this.socket.on('error', () =>
      this.emit('fault', new AppError('live_connection_failed', 'OpenAI 음성 연결 실패', 502)),
    );
    this.socket.on('close', () => {
      this.cancelReply();
      this.clearInstructions();
      clearTimeout(this.deadline);
      if (!this.closing && !this.finalized)
        this.emit(
          'fault',
          new AppError('live_disconnected', 'OpenAI 음성 연결이 끊겼습니다.', 502),
        );
    });
  }
  send(event: unknown) {
    if (this.socket.readyState !== WebSocket.OPEN) return;
    if (this.socket.bufferedAmount > 80000) {
      this.emit(
        'fault',
        new AppError('live_backpressure', 'OpenAI 입력 음성 지연이 10초를 초과했습니다.', 502),
      );
      return;
    }
    this.socket.send(JSON.stringify(event));
  }
  waitReady(ms = 12000): Promise<string> {
    if (this.sessionId) return Promise.resolve(this.sessionId);
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.off('ready', ready);
        this.off('fault', fault);
      };
      const ready = (id: string) => {
        cleanup();
        resolve(id);
      };
      const fault = (error: Error) => {
        cleanup();
        reject(error);
      };
      const timer = setTimeout(
        () =>
          fault(
            new AppError(
              'live_start_timeout',
              'OpenAI 음성 세션 시작 미확인. 전화는 걸지 않았습니다.',
              504,
            ),
          ),
        ms,
      );
      this.once('ready', ready);
      this.once('fault', fault);
    });
  }
  steer(content: string) {
    const id = randomUUID();
    const timer = setTimeout(() => {
      this.pendingInstructions.delete(id);
      if (!this.closing && !this.finalized) this.emit('instruction-unconfirmed', id);
    }, 5000);
    timer.unref();
    this.pendingInstructions.set(id, timer);
    this.send({
      type: 'session.instructions.append',
      event_id: id,
      delegation_id: null,
      content,
    });
    return id;
  }
  greet(scenario: Scenario) {
    if (this.greetingSent || !this.sessionId || this.closing) return;
    this.greetingSent = true;
    this.say(
      scenario === 'resident'
        ? residentQuestions.location
        : '가상의 구조 요청에 참여 가능하신가요?',
    );
  }
  say(line: string) {
    this.currentLine = line;
    this.cancelReply();
    this.steer(
      `Begin speaking immediately in Korean, without waiting for the caller to speak. Say exactly this sentence in full: "${line}". Do not combine it with previous questions or add any other words. Then pause and listen until the next app instruction.`,
    );
  }
  waitReply() {
    this.cancelReply();
    if (!this.greetingSent || this.closing || this.concluding || this.finalized) return;
    this.replyTimer = setTimeout(() => {
      this.replyTimer = undefined;
      this.steer(
        '수신자가 답을 했습니다. 최신 답에 한국어로 응답하고, 이미 답한 질문을 반복하지 말고 다음 질문을 한 번에 하나만 합니다. 모호하면 짧게 확인합니다. 외부 행동을 약속하지 않습니다.',
      );
      this.emit('reply-nudge');
    }, 4000);
    this.replyTimer.unref();
  }
  cancelReply() {
    clearTimeout(this.replyTimer);
    this.replyTimer = undefined;
  }
  conclude(line = farewell) {
    this.concluding = true;
    this.cancelReply();
    this.say(line);
  }
  resume() {
    this.concluding = false;
    this.steer(
      '수신자가 완료 신고를 정정했습니다. 자동 종료를 취소했습니다. 현재 위치와 도움 필요 여부를 한국어로 한 번에 한 질문씩 다시 확인합니다.',
    );
  }
  close() {
    if (this.closing) return;
    this.closing = true;
    this.cancelReply();
    this.clearInstructions();
    if (this.sessionId) this.send({ type: 'session.close' });
    else this.socket.terminate();
    this.deadline = setTimeout(() => this.socket.terminate(), 5000);
    this.deadline.unref();
  }
  dispose() {
    this.closing = true;
    this.cancelReply();
    this.clearInstructions();
    clearTimeout(this.deadline);
    this.socket.terminate();
  }
  private clearInstructions() {
    for (const timer of this.pendingInstructions.values()) clearTimeout(timer);
    this.pendingInstructions.clear();
  }
}
