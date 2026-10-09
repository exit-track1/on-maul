import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { ConfigStore, writePrivate } from './config.ts';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { AppError, redact, type Scenario } from './domain.ts';
import { LiveConnection, sessionConfig, type SocketFactory } from './live.ts';
export class VoiceDemo extends EventEmitter {
  store: ConfigStore;
  fetcher: typeof fetch;
  factory?: SocketFactory;
  live?: LiveConnection;
  state: {
    id: string;
    sessionId: string | null;
    status: string;
    blocked: boolean;
    scenario: Scenario;
    transcript: { speaker: string; text: string }[];
  } = {
    id: '',
    sessionId: null,
    status: 'idle',
    blocked: false,
    scenario: 'resident',
    transcript: [],
  };
  private timer?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private closeTimer?: NodeJS.Timeout;
  private stopRequested = false;
  recordingConsent = false;
  journal: string;
  constructor(store: ConfigStore, fetcher: typeof fetch = fetch, factory?: SocketFactory) {
    super();
    this.store = store;
    this.fetcher = fetcher;
    this.factory = factory;
    this.journal = join(dirname(store.path), 'active-voice.json');
    if (existsSync(this.journal)) {
      try {
        const previous = JSON.parse(readFileSync(this.journal, 'utf8'));
        if (previous.blocked)
          this.state = {
            ...this.state,
            ...previous,
            status: 'unknown',
            blocked: true,
            transcript: [],
          };
      } catch {
        this.state.status = 'unknown';
        this.state.blocked = true;
      }
    }
    this.on('update', () => {
      const { transcript, ...record } = this.state;
      writePrivate(this.journal, record);
    });
  }
  public() {
    return structuredClone(this.state);
  }
  busy() {
    return this.state.blocked;
  }
  async start(input: Record<string, unknown>, context = '') {
    if (this.busy()) throw new AppError('voice_locked', '브라우저 음성 대화가 진행 중입니다.', 409);
    if (
      input.consent !== true ||
      typeof input.sdp !== 'string' ||
      !input.sdp.startsWith('v=0') ||
      input.sdp.length > 64000
    )
      throw new AppError('voice_input_invalid', '동의와 유효한 WebRTC SDP가 필요합니다.');
    if (!this.store.value.OPENAI_API_KEY)
      throw new AppError('openai_key_missing', 'OpenAI API 키를 저장하세요.');
    const config = { ...this.store.value };
    this.live?.dispose();
    this.live = undefined;
    this.stopRequested = false;
    const id = randomUUID();
    const scenario: Scenario = input.scenario === 'standby' ? 'standby' : 'resident';
    this.recordingConsent = input.recordingConsent === true;
    this.state = {
      id,
      sessionId: null,
      status: 'creating',
      blocked: true,
      scenario,
      transcript: [],
    };
    this.emit('update', this.public());
    try {
      const session = sessionConfig(config, scenario, context);
      const { format, ...audio } = session.audio;
      const r = await this.fetcher('https://api.openai.com/v1/live/sessions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(15000),
        body: JSON.stringify({
          session: { ...session, audio },
          transport: { type: 'webrtc', sdp: input.sdp },
        }),
      });
      if (!r.ok) throw new AppError('webrtc_start_failed', `WebRTC API HTTP ${r.status}`, r.status);
      const data = (await r.json()) as any;
      if (typeof data.session?.id !== 'string' || typeof data.transport?.sdp !== 'string')
        throw new AppError('webrtc_response_invalid', 'WebRTC 응답 형식 오류', 502);
      this.state.sessionId = data.session.id;
      this.live = new LiveConnection(config, scenario, this.factory, context, data.session.id);
      this.live.on('fault', () => {
        if (this.state.id === id && this.state.blocked) {
          this.state.status = 'unknown';
          this.emit('update', this.public());
        }
      });
      this.live.on('event', (event) => {
        if (this.state.id !== id) return;
        if (event.type === 'session.closed') {
          this.state.status = 'ended';
          this.state.blocked = false;
          clearTimeout(this.timer);
          clearTimeout(this.heartbeatTimer);
          clearTimeout(this.closeTimer);
          this.emit('update', this.public());
        }
        if (
          ['session.input_transcript.delta', 'session.output_transcript.delta'].includes(
            event.type,
          ) &&
          typeof event.delta === 'string'
        ) {
          const text = redact(event.delta, this.store.secrets());
          this.state.transcript.push({
            speaker: event.type === 'session.input_transcript.delta' ? 'user' : 'assistant',
            text,
          });
          this.state.transcript = this.state.transcript.slice(-1000);
          this.emit('trusted-transcript', { id, event: { ...event, delta: text } });
          this.emit('update', this.public());
        }
      });
      await this.live.waitReady();
      if (this.stopRequested) {
        this.stop(id);
        throw new AppError('voice_start_cancelled', '음성 시작 중 종료 요청을 적용했습니다.', 409);
      }
      this.state.status = 'connecting';
      this.emit('update', this.public());
      this.timer = setTimeout(() => this.stop(id), config.MAX_CALL_SECONDS * 1000);
      this.timer.unref();
      this.heartbeat(id);
      return { id, sessionId: data.session.id, sdp: data.transport.sdp };
    } catch (error) {
      if (this.live) {
        if (this.state.blocked) this.stop(id);
      } else {
        const ambiguous = !(error instanceof AppError) || error.status >= 500;
        this.state.status = ambiguous ? 'unknown' : 'failed';
        this.state.blocked = ambiguous;
      }
      this.emit('update', this.public());
      throw error;
    }
  }
  ready(id: unknown) {
    if (
      id !== this.state.id ||
      !this.state.blocked ||
      !['connecting', 'connected'].includes(this.state.status)
    )
      throw new AppError('wrong_voice', '진행 중인 음성 ID가 아닙니다.', 409);
    this.state.status = 'connected';
    this.live!.greet(this.state.scenario);
    this.emit('update', this.public());
    return this.public();
  }
  heartbeat(id: unknown) {
    if (id !== this.state.id || !this.state.blocked)
      throw new AppError('wrong_voice', '음성 ID 확인', 409);
    clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = setTimeout(() => this.stop(String(id)), 15000);
    this.heartbeatTimer.unref();
    return this.public();
  }
  resolve(confirmed: unknown) {
    if (this.state.status !== 'unknown' || confirmed !== true)
      throw new AppError(
        'voice_confirmation_required',
        '브라우저·OpenAI 음성 종료 확인이 필요합니다.',
        409,
      );
    this.live?.dispose();
    clearTimeout(this.timer);
    clearTimeout(this.heartbeatTimer);
    clearTimeout(this.closeTimer);
    this.state.status = 'ended';
    this.state.blocked = false;
    this.emit('update', this.public());
    return this.public();
  }
  stop(id: string) {
    if (id !== this.state.id || !this.state.blocked) return this.public();
    this.stopRequested = true;
    clearTimeout(this.timer);
    clearTimeout(this.heartbeatTimer);
    this.state.status = 'ending';
    this.live?.close();
    this.emit('update', this.public());
    // A pending creation response must still be attached and closed when it arrives.
    if (!this.live) return this.public();
    const current = this.live;
    clearTimeout(this.closeTimer);
    this.closeTimer = setTimeout(() => {
      if (this.live === current && this.state.blocked) {
        this.state.status = 'unknown';
        this.emit('update', this.public());
      }
    }, 5500).unref();
    return this.public();
  }
  dispose() {
    clearTimeout(this.timer);
    clearTimeout(this.heartbeatTimer);
    clearTimeout(this.closeTimer);
    this.live?.dispose();
  }
}
