import { EventEmitter } from 'node:events';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type WebSocket from 'ws';
import { ConfigStore, writePrivate, type Config } from './config.ts';
import {
  AppError,
  completionBlocked,
  farewell,
  normalizePhone,
  redact,
  type CallStatus,
  type Scenario,
} from './domain.ts';
import { LiveConnection, type SocketFactory } from './live.ts';
import { AudioBridge, muLawRms } from './media.ts';
import { classifyEvacuation, type Transcript } from './evacuation.ts';
import { CallOutcomeStore, type Completion } from './call-outcomes.ts';
import {
  advanceResident,
  finishResident,
  residentAssessment,
  residentQuestions,
  scenarioWrapSeconds,
  scenarioLimitSeconds,
  type ResidentAssessment,
} from './resident-flow.ts';
export type Report = {
  location: string;
  evidence: string;
  targetId?: string;
  scenarioCallId?: string;
};
export type CallView = {
  id: string;
  sessionId: string | null;
  callControlId: string | null;
  status: CallStatus;
  blocked: boolean;
  scenario: Scenario;
  phone: string;
  requestedAt: number | null;
  answeredAt: number | null;
  endedAt: number | null;
  sessionCreated: boolean;
  dialSent: boolean;
  answerObserved: boolean;
  mediaConnected: boolean;
  notice: string;
  error: { code: string; message: string; action: string } | null;
  audioInSeconds: number;
  audioOutSeconds: number;
  audioClears: number;
  audioUnderruns: number;
  audioBufferedMs: number;
  events: { at: number; type: string; message: string }[];
  transcript: Transcript[];
  completion?: Completion;
  assessment?: ResidentAssessment;
};
export type CallClassifier = (
  config: Config,
  text: string,
  context: Transcript[],
  valid: () => boolean,
) => Promise<Report | null>;
type Run = {
  view: CallView;
  config: Config;
  token: string;
  clientState: string;
  live?: LiveConnection;
  media?: WebSocket;
  bridge?: AudioBridge;
  seen: Set<string>;
  stopRequested: boolean;
  dialPending: boolean;
  hangupSent: boolean;
  generation: number;
  buffer: string;
  farewellText: string;
  farewellAudio: boolean;
  farewellClears: number;
  mark?: string;
  timers: Set<NodeJS.Timeout>;
  maxTimer?: NodeJS.Timeout;
  inputTimer?: NodeJS.Timeout;
  mediaTimer?: NodeJS.Timeout;
  farewellTimer?: NodeJS.Timeout;
  farewellDeadline?: NodeJS.Timeout;
  silenceTimer?: NodeJS.Timeout;
  scenarioTimer?: NodeJS.Timeout;
  scenarioDeadline?: NodeJS.Timeout;
  link?: { targetId: string; scenarioCallId: string };
  classify: CallClassifier;
  linkedClassifier?: boolean;
};
function idle(): CallView {
  return {
    id: '',
    sessionId: null,
    callControlId: null,
    status: 'idle',
    blocked: false,
    scenario: 'resident',
    phone: '',
    requestedAt: null,
    answeredAt: null,
    endedAt: null,
    sessionCreated: false,
    dialSent: false,
    answerObserved: false,
    mediaConnected: false,
    notice: '설정을 저장하고 연결을 확인하세요.',
    error: null,
    audioInSeconds: 0,
    audioOutSeconds: 0,
    audioClears: 0,
    audioUnderruns: 0,
    audioBufferedMs: 0,
    events: [],
    transcript: [],
  };
}
export class CallManager extends EventEmitter {
  store: ConfigStore;
  outcomeStore: CallOutcomeStore;
  journal: string;
  current: Run;
  fetcher: typeof fetch;
  factory?: SocketFactory;
  requestTimeoutMs: number;
  disposed = false;
  constructor(
    store: ConfigStore,
    directory: string,
    options: {
      fetcher?: typeof fetch;
      socketFactory?: SocketFactory;
      requestTimeoutMs?: number;
    } = {},
  ) {
    super();
    this.store = store;
    this.fetcher = options.fetcher ?? fetch;
    this.factory = options.socketFactory;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15000;
    this.journal = join(directory, 'active-call.json');
    this.outcomeStore = new CallOutcomeStore(join(directory, 'call-outcomes'));
    let view = idle();
    view.notice = '설정을 저장하고 연결을 확인하세요. 실제 발신은 발신 버튼으로만 시작합니다.';
    if (existsSync(this.journal)) {
      try {
        const old = JSON.parse(readFileSync(this.journal, 'utf8'));
        view = { ...view, ...old, events: [], transcript: [] };
        if (old.blocked) {
          view.status = 'unknown';
          view.blocked = true;
          view.notice =
            '서버 재시작으로 이전 통화 종료 여부가 불명확합니다. Telnyx에서 확인하세요.';
        }
      } catch {
        view.status = 'unknown';
        view.blocked = true;
        view.notice =
          '이전 통화 기록을 읽을 수 없어 발신을 잠갔습니다. Telnyx 종료 확인이 필요합니다.';
      }
    }
    this.current = this.run(view, { ...store.value });
  }
  run(view: CallView, config: Config): Run {
    return {
      view,
      config,
      token: randomBytes(32).toString('hex'),
      clientState: Buffer.from(JSON.stringify({ localCallId: view.id })).toString('base64'),
      seen: new Set(),
      stopRequested: false,
      dialPending: false,
      hangupSent: false,
      generation: 0,
      buffer: '',
      farewellText: '',
      farewellAudio: false,
      farewellClears: 0,
      timers: new Set(),
      classify: async (c, t, ctx) => {
        const result = await classifyEvacuation(c, t, ctx, this.fetcher);
        return result ? { location: result.location, evidence: result.evidence } : null;
      },
    };
  }
  public() {
    return structuredClone(this.current.view);
  }
  busy() {
    return this.current.view.blocked;
  }
  valid(run: Run) {
    return !this.disposed && this.current === run && run.view.blocked && !run.stopRequested;
  }
  after(run: Run, ms: number, fn: () => void) {
    const timer = setTimeout(() => {
      run.timers.delete(timer);
      if (this.current === run && !this.disposed) fn();
    }, ms);
    run.timers.add(timer);
    timer.unref();
    return timer;
  }
  saveOutcome(run: Run, completion = run.view.completion) {
    if (completion)
      this.outcomeStore.save({
        callId: run.view.id,
        sessionId: run.view.sessionId,
        phone: run.view.phone,
        scenario: run.view.scenario,
        completion,
        callStatus: run.view.status,
        endedAt: run.view.endedAt,
      });
  }
  publish(run = this.current) {
    if (run !== this.current || this.disposed) return;
    const { events, transcript, ...persisted } = run.view;
    writePrivate(this.journal, persisted);
    this.saveOutcome(run);
    this.emit('update', this.public());
  }
  log(run: Run, type: string, message: string) {
    if (run !== this.current || this.disposed) return;
    run.view.events.push({ at: Date.now(), type, message: redact(message, this.store.secrets()) });
    run.view.events = run.view.events.slice(-200);
    this.publish(run);
  }
  error(run: Run, error: unknown) {
    const e =
      error instanceof AppError
        ? error
        : new AppError('request_failed', error instanceof Error ? error.message : '요청 오류', 502);
    run.view.error = {
      code: e.code,
      message: redact(e.message, this.store.secrets()),
      action: e.action,
    };
  }
  validateStart(input: Record<string, unknown>) {
    if (this.busy())
      throw new AppError('call_locked', '진행 중이거나 종료가 불명확한 통화가 있습니다.', 409);
    if (input.consent !== true)
      throw new AppError('consent_required', '수신자의 테스트 전화 동의가 필요합니다.');
    if (input.scenario !== 'resident' && input.scenario !== 'standby')
      throw new AppError('invalid_scenario', '주민 또는 대기조를 선택하세요.');
    const config = this.store.value;
    for (const key of [
      'OPENAI_API_KEY',
      'TELNYX_API_KEY',
      'TELNYX_APPLICATION_ID',
      'TELNYX_PUBLIC_KEY',
      'PUBLIC_BASE_URL',
      'CALLER_NUMBER',
      'TEST_PHONE',
    ] as const)
      if (!config[key]) throw new AppError('missing_setting', `${key} 설정이 필요합니다.`);
    if (
      input.phone !== undefined &&
      normalizePhone(String(input.phone), true) !== config.TEST_PHONE
    )
      throw new AppError('save_number_first', '수신번호를 먼저 설정에 저장하세요.');
    if (config.CALLER_NUMBER === config.TEST_PHONE)
      throw new AppError('same_phone', '발신번호와 수신번호가 같습니다.');
  }
  async telnyx(run: Run, path: string, payload?: unknown, method = 'POST') {
    const response = await this.fetcher('https://api.telnyx.com/v2' + path, {
      method,
      headers: {
        Authorization: `Bearer ${run.config.TELNYX_API_KEY}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(this.requestTimeoutMs),
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    const body = (await response.json()) as any;
    if (!response.ok) {
      const e = body.errors?.[0] ?? body.error;
      throw new AppError(
        `telnyx_${e?.code ?? response.status}`,
        String(e?.detail ?? e?.title ?? e?.message ?? `HTTP ${response.status}`),
        response.status,
      );
    }
    return body.data ?? body;
  }
  async start(
    input: Record<string, unknown>,
    options: {
      context?: string;
      beforeDial?: () => Promise<void>;
      classifier?: CallClassifier;
      link?: { targetId: string; scenarioCallId: string };
    } = {},
  ) {
    this.validateStart(input);
    const config = { ...this.store.value };
    const run = this.run(
      {
        ...idle(),
        id: randomUUID(),
        scenario: input.scenario as Scenario,
        phone: config.TEST_PHONE,
        status: 'requesting',
        blocked: true,
        requestedAt: Date.now(),
      },
      config,
    );
    this.current = run;
    run.link = options.link;
    if (options.classifier) {
      run.classify = options.classifier;
      run.linkedClassifier = true;
    }
    this.log(run, 'preparing', 'OpenAI 음성 세션 준비 중입니다. 전화는 아직 걸지 않았습니다.');
    run.maxTimer = this.after(run, config.MAX_CALL_SECONDS * 1000, () => {
      void this.stop('최대 통화시간').catch(() => {});
    });
    try {
      run.live = new LiveConnection(
        config,
        run.view.scenario,
        this.factory,
        options.context,
        undefined,
        run.view.scenario === 'resident',
      );
      run.live.on('fault', (error) => {
        if (this.valid(run) && run.view.dialSent) {
          this.error(run, error);
          void this.stop('음성 오류').catch(() => {});
        }
      });
      run.live.on('event', (event) => this.liveEvent(run, event));
      run.live.on('reply-nudge', () => {
        if (this.valid(run))
          this.log(run, 'reply_resumed', 'AI 답변 지연으로 대화 재개를 한 번 요청했습니다.');
      });
      run.live.on('delegation-handled', () => {
        if (this.valid(run))
          this.log(run, 'delegation_handled', '앱에서 짧은 통화 시나리오를 계속 진행합니다.');
      });
      run.view.sessionId = await run.live.waitReady(this.requestTimeoutMs);
      run.view.sessionCreated = true;
      run.silenceTimer = setInterval(() => {
        if (this.valid(run) && !run.bridge?.active)
          run.live!.send({
            type: 'session.input_audio.append',
            audio: Buffer.alloc(160, 255).toString('base64'),
          });
      }, 20);
      run.silenceTimer.unref();
      this.log(
        run,
        'session_started',
        `${config.LIVE_MODEL} 세션 시작 확인. 전화 응답은 별도입니다.`,
      );
      await options.beforeDial?.();
      if (!this.valid(run)) {
        this.finish(run, '발신 전 취소');
        return this.public();
      }
      run.view.dialSent = true;
      run.dialPending = true;
      this.log(
        run,
        'dial_requested',
        'Telnyx 실제 발신을 1회 요청합니다. 자동 재발신하지 않습니다.',
      );
      const result = await this.telnyx(run, '/calls', {
        connection_id: config.TELNYX_APPLICATION_ID,
        from: config.CALLER_NUMBER,
        to: config.TEST_PHONE,
        command_id: run.view.id,
        client_state: run.clientState,
        webhook_url: config.PUBLIC_BASE_URL + '/webhooks/telnyx',
        webhook_url_method: 'POST',
        stream_url: config.PUBLIC_BASE_URL.replace('https:', 'wss:') + '/media/' + run.token,
        stream_track: 'inbound_track',
        stream_codec: 'PCMU',
        stream_bidirectional_mode: 'rtp',
        stream_bidirectional_codec: 'PCMU',
        stream_bidirectional_sampling_rate: 8000,
        stream_bidirectional_target_legs: 'self',
        retry_on_timeout: false,
        time_limit_secs: config.MAX_CALL_SECONDS,
        timeout_secs: Math.min(45, config.MAX_CALL_SECONDS),
      });
      run.dialPending = false;
      if (typeof result.call_control_id !== 'string' || !result.call_control_id)
        throw new AppError('dial_response_invalid', '발신 통화 ID 누락', 502);
      if (run.view.callControlId && run.view.callControlId !== result.call_control_id)
        throw new AppError('dial_id_mismatch', '발신 응답 통화 ID 불일치', 502);
      run.view.callControlId = result.call_control_id;
      if (!run.view.blocked) return this.public();
      if (run.stopRequested) await this.stop('발신 처리 중 종료 요청');
      else {
        if (!run.view.answerObserved && run.view.status === 'requesting')
          run.view.status = 'created';
        this.log(
          run,
          'dial_accepted',
          '발신 접수 확인. 수신 응답과 미디어 시작은 별도로 기다립니다.',
        );
        this.activate(run);
      }
    } catch (error) {
      run.dialPending = false;
      this.error(run, error);
      if (run.view.blocked && run.view.callControlId) await this.stop('발신 오류');
      else if (run.view.blocked) {
        const uncertain =
          run.view.dialSent &&
          (!(error instanceof AppError) ||
            error.status >= 500 ||
            [408, 429].includes(error.status));
        run.view.status = uncertain ? 'unknown' : 'failed';
        run.view.blocked = uncertain;
        run.stopRequested = uncertain;
        this.clean(run);
        this.log(
          run,
          run.view.status,
          uncertain
            ? '발신 결과가 불명확해 새 발신을 잠갔습니다. Telnyx에서 종료를 확인하세요.'
            : '준비 또는 발신 요청이 실패했습니다.',
        );
      }
    }
    return this.public();
  }
  webhook(event: any) {
    const run = this.current,
      data = event?.data,
      p = data?.payload;
    if (
      this.disposed ||
      !run.view.dialSent ||
      typeof data?.id !== 'string' ||
      typeof data?.event_type !== 'string' ||
      !p ||
      typeof p.call_control_id !== 'string'
    )
      return;
    const streaming = data.event_type.startsWith('streaming.');
    if (
      streaming ? p.call_control_id !== run.view.callControlId : p.client_state !== run.clientState
    )
      return;
    if (
      (run.view.callControlId && p.call_control_id !== run.view.callControlId) ||
      (p.to && p.to !== run.view.phone) ||
      (p.connection_id && String(p.connection_id) !== run.config.TELNYX_APPLICATION_ID) ||
      run.seen.has(data.id)
    )
      return;
    run.seen.add(data.id);
    if (run.seen.size > 10000) run.seen.delete(run.seen.values().next().value!);
    run.view.callControlId = p.call_control_id;
    if (data.event_type === 'call.hangup') {
      if (!run.view.blocked) return;
      this.finish(run, `Telnyx 최종 종료 확인: ${String(p.hangup_cause ?? '종료')}`);
      return;
    }
    if (!run.view.blocked) return;
    if (run.stopRequested) {
      if (!run.dialPending && !run.hangupSent) void this.stop('늦은 통화 ID 확인').catch(() => {});
      return;
    }
    if (data.event_type === 'call.answered' && !run.view.answerObserved) {
      run.view.answerObserved = true;
      run.view.answeredAt = Date.now();
      run.view.status = 'answered';
      if (run.view.scenario === 'resident') {
        run.view.assessment = residentAssessment();
        run.scenarioTimer = this.after(run, scenarioWrapSeconds * 1000, () =>
          this.finishAssessment(run, true),
        );
        run.scenarioDeadline = this.after(run, scenarioLimitSeconds * 1000, () => {
          if (this.valid(run)) {
            this.log(
              run,
              'scenario_deadline',
              '60초 시나리오 제한. 안내 재생 상태를 보존하고 종료합니다.',
            );
            void this.stop('60초 시나리오 종료').catch(() => {});
          }
        });
      }
      this.log(run, 'answered', '서명된 수신 응답 확인. 사람 또는 음성사서함인지는 아직 모릅니다.');
      this.activate(run);
      if (!run.bridge && !run.mediaTimer)
        run.mediaTimer = this.after(run, 12000, () => this.mediaFault(run, 'media_start_timeout'));
    } else if (data.event_type === 'call.initiated' && !run.view.answerObserved) {
      if (run.view.status === 'ringing') return;
      run.view.status = p.state === 'ringing' ? 'ringing' : 'created';
      this.log(
        run,
        run.view.status,
        p.state === 'ringing' ? '통신사 벨소리 상태 확인' : '통신사 발신 시작 확인',
      );
    } else if (data.event_type === 'streaming.failed' || data.event_type === 'streaming.stopped')
      this.mediaFault(run, data.event_type);
  }
  mediaAllowed(token: string) {
    const run = this.current;
    return (
      this.valid(run) &&
      run.view.dialSent &&
      !run.media &&
      token.length === run.token.length &&
      timingSafeEqual(Buffer.from(token), Buffer.from(run.token))
    );
  }
  attachMedia(socket: WebSocket) {
    const run = this.current;
    if (!this.mediaAllowed(run.token)) {
      socket.close();
      return;
    }
    run.media = socket;
    socket.on('message', (raw) => {
      if (!this.valid(run)) return;
      let event: any;
      try {
        event = JSON.parse(raw.toString());
      } catch {
        this.mediaFault(run, 'media_json_invalid');
        return;
      }
      if (event.event === 'start') {
        if (run.bridge) return;
        const start = event.start,
          format = start?.media_format;
        if (
          start?.client_state !== run.clientState ||
          !start?.call_control_id ||
          (run.view.callControlId && run.view.callControlId !== start.call_control_id) ||
          format?.encoding !== 'PCMU' ||
          Number(format.sample_rate) !== 8000 ||
          Number(format.channels) !== 1
        ) {
          this.mediaFault(run, 'media_identity_invalid');
          return;
        }
        run.view.callControlId = start.call_control_id;
        run.view.mediaConnected = true;
        clearTimeout(run.mediaTimer);
        run.bridge = new AudioBridge(
          socket,
          run.live!,
          (code) => this.mediaFault(run, code),
          () => this.playbackCleared(run),
          () => {
            if (this.valid(run)) {
              run.view.audioInSeconds = run.bridge!.inputBytes / 8000;
              run.view.audioOutSeconds = run.bridge!.outputBytes / 8000;
              run.view.audioClears = run.bridge!.clears;
              run.view.audioUnderruns = run.bridge!.outputUnderruns;
              run.view.audioBufferedMs = run.bridge!.outputBufferedMs;
              this.emit('update', this.public());
            }
          },
        );
        this.log(run, 'media_started', 'PCMU 8000Hz mono 음성 시작 확인');
        this.activate(run);
      } else if (event.event === 'media' && event.media?.track === 'inbound')
        run.bridge?.input(Number(event.media.chunk), event.media.payload);
      else if (
        event.event === 'mark' &&
        event.mark?.name === run.mark &&
        run.mark &&
        run.bridge?.sentMarks.has(run.mark) &&
        run.bridge.clears === run.farewellClears &&
        run.view.completion?.status === 'reported'
      ) {
        run.view.completion.playbackConfirmed = true;
        this.log(run, 'playback_confirmed', 'Telnyx 종료 안내 재생 확인');
        void this.stop('완료 안내 재생 확인').catch(() => {});
      } else if (event.event === 'stop' || event.event === 'error')
        this.mediaFault(run, 'media_stream_stopped');
    });
    socket.on('error', () => this.mediaFault(run, 'media_socket_failed'));
    socket.on('close', () => this.mediaFault(run, 'media_disconnected'));
  }
  activate(run: Run) {
    if (!this.valid(run) || !run.view.answerObserved || !run.bridge || !run.live?.sessionId) return;
    clearInterval(run.silenceTimer);
    run.silenceTimer = undefined;
    run.bridge.active = true;
    run.live.greet(run.view.scenario);
  }
  mediaFault(run: Run, code: string) {
    if (!this.valid(run)) return;
    this.error(
      run,
      new AppError(
        code,
        /overflow|backpressure/.test(code)
          ? '음성 버퍼 또는 송신 지연이 10초 제한을 초과했습니다.'
          : '전화 음성 브리지 연결을 확인할 수 없습니다.',
        502,
      ),
    );
    void this.stop('음성 오류').catch(() => {});
  }
  liveEvent(run: Run, event: any) {
    if (run !== this.current || this.disposed) return;
    if (event.type === 'session.output_audio.delta' && this.valid(run)) {
      if (run.bridge?.appendOutput(event.delta) && run.view.completion?.status === 'reported') {
        const speech = muLawRms(Buffer.from(event.delta, 'base64')) > 100;
        run.farewellAudio ||= speech;
        // Live also streams silence. Silence must not indefinitely postpone the final mark.
        if (speech) this.scheduleFarewell(run);
      }
    }
    if (
      ['session.input_transcript.delta', 'session.output_transcript.delta'].includes(event.type) &&
      typeof event.delta === 'string'
    ) {
      const speaker = event.type === 'session.input_transcript.delta' ? 'user' : 'assistant';
      const text = redact(event.delta, this.store.secrets());
      const last = run.view.transcript.at(-1);
      if (last?.speaker === speaker) last.text = (last.text + text).slice(-8000);
      else run.view.transcript.push({ speaker, text });
      run.view.transcript = run.view.transcript.slice(-100);
      if (speaker === 'user') {
        if (
          !run.buffer &&
          run.bridge?.active &&
          !['rescue', 'moving'].includes(run.view.completion?.kind ?? '')
        )
          run.bridge.clear();
        this.inputTranscript(run, text);
      } else if (run.view.completion?.status === 'reported') {
        run.farewellText += text;
        this.scheduleFarewell(run);
      }
      this.emit('trusted-transcript', {
        id: run.view.id,
        sessionId: run.view.sessionId,
        event: { ...event, delta: text },
      });
      this.emit('update', this.public());
    }
    if (event.type === 'session.closed' && this.valid(run)) {
      this.error(run, new AppError('live_closed', '통화 중 음성 세션이 종료됐습니다.', 502));
      void this.stop('음성 세션 종료').catch(() => {});
    }
    if (
      event.type === 'response.event' &&
      event.event?.type === 'response.failed' &&
      this.valid(run)
    ) {
      this.error(run, new AppError('backend_failed', '대화 위임 모델 응답 실패', 502));
      void this.stop('위임 오류').catch(() => {});
    }
  }
  inputTranscript(run: Run, text: string) {
    if (
      !this.valid(run) ||
      (run.view.scenario !== 'resident' && !run.linkedClassifier) ||
      !run.bridge?.active
    )
      return;
    run.buffer = (run.buffer + text).slice(-4000);
    run.generation++;
    clearTimeout(run.inputTimer);
    if (
      run.view.completion?.status === 'reported' &&
      !['rescue', 'moving'].includes(run.view.completion.kind ?? '') &&
      completionBlocked(run.buffer)
    ) {
      clearTimeout(run.farewellDeadline);
      clearTimeout(run.farewellTimer);
      run.bridge.cancelMark(run.mark);
      run.mark = undefined;
      run.view.completion = {
        ...run.view.completion,
        status: 'needs_review',
        correction: run.buffer,
        playbackConfirmed: false,
      };
      run.bridge.clear();
      this.log(
        run,
        'completion_corrected',
        '대피 완료 신고 정정. 자동 종료를 취소하고 재확인합니다.',
      );
      run.live!.resume();
    } else if (run.view.completion?.status === 'needs_review' && run.view.completion.correction) {
      run.view.completion.correction += text;
      this.publish(run);
    }
    const generation = run.generation;
    const consume = () => {
      if (run.bridge?.inputSpeaking) {
        run.inputTimer = this.after(run, 250, consume);
        return;
      }
      const utterance = run.buffer;
      run.buffer = '';
      if (run.view.completion?.status === 'reported') return;
      const valid = () =>
        this.valid(run) &&
        generation === run.generation &&
        run.view.completion?.status !== 'reported';
      void run
        .classify(run.config, utterance, structuredClone(run.view.transcript).slice(-8), valid)
        .then((report) => {
          if (!valid()) return;
          if (report && utterance.includes(report.evidence)) this.complete(run, report);
          else this.advanceAssessment(run, utterance);
        })
        .catch(() => {
          if (valid()) {
            this.log(run, 'classification_failed', '대피 완료 판단 실패. 통화를 유지합니다.');
            this.advanceAssessment(run, utterance);
          }
        });
    };
    run.inputTimer = this.after(run, run.live?.controlled ? 900 : 1500, consume);
  }
  advanceAssessment(run: Run, text: string) {
    const assessment = run.view.assessment;
    if (
      !this.valid(run) ||
      !assessment ||
      assessment.stage === 'done' ||
      run.view.completion?.status === 'reported'
    )
      return;
    advanceResident(assessment, text);
    if (run.view.assessment!.stage === 'done') this.finishAssessment(run);
    else {
      this.log(
        run,
        'scenario_step',
        `${assessment.stage === 'mobility' ? '이동 가능 여부' : '몸 상태'} 확인`,
      );
      run.live!.say(residentQuestions[assessment.stage]);
    }
  }
  finishAssessment(run: Run, timedOut = false) {
    if (
      !this.valid(run) ||
      !run.bridge?.active ||
      !run.view.assessment ||
      run.view.completion?.status === 'reported'
    )
      return;
    const result = finishResident(run.view.assessment, timedOut);
    this.complete(run, result);
  }
  complete(
    run: Run,
    report: Report & Partial<Pick<Completion, 'kind' | 'closingText' | 'assessment'>>,
  ) {
    if (
      !this.valid(run) ||
      run.view.scenario !== 'resident' ||
      run.view.completion?.status === 'reported' ||
      !report.evidence.trim()
    )
      return;
    const completion: Completion = {
      ...report,
      ...run.link,
      status: 'reported',
      recordedAt: Date.now(),
      playbackConfirmed: false,
    };
    try {
      this.saveOutcome(run, completion);
    } catch {
      this.log(
        run,
        'completion_save_failed',
        '완료 근거를 저장하지 못했습니다. 완료 안내와 자동 종료를 하지 않습니다.',
      );
      return;
    }
    run.view.completion = completion;
    clearTimeout(run.scenarioTimer);
    run.farewellText = '';
    run.farewellAudio = false;
    run.mark = undefined;
    run.bridge!.clear();
    run.farewellClears = run.bridge!.clears;
    this.log(
      run,
      'completion_saved',
      completion.kind === 'rescue'
        ? '구조 확인 요청을 저장했습니다. 안내 재생·최종 종료 후 후속 절차를 진행합니다.'
        : '수신자 응답을 저장했습니다. 안내 재생 확인 후 종료합니다.',
    );
    run.live!.conclude(completion.closingText ?? farewell);
    run.farewellDeadline = this.after(run, 30000, () => {
      if (this.valid(run) && run.view.completion?.status === 'reported') {
        this.log(
          run,
          'playback_unconfirmed',
          '30초 내 종료 안내 재생을 확인하지 못했습니다. 미확인으로 종료를 요청합니다.',
        );
        void this.stop('안내 재생 미확인 제한').catch(() => {});
      }
    });
  }
  scheduleFarewell(run: Run) {
    clearTimeout(run.farewellTimer);
    run.bridge?.cancelMark(run.mark);
    run.mark = undefined;
    if (
      !this.valid(run) ||
      !run.farewellAudio ||
      run.view.completion?.status !== 'reported' ||
      run.bridge?.clears !== run.farewellClears ||
      !run.farewellText
        .replace(/\s|[.!?,]/g, '')
        .includes((run.view.completion.closingText ?? farewell).replace(/\s|[.!?,]/g, ''))
    )
      return;
    run.farewellTimer = this.after(run, 1500, () => {
      if (
        this.valid(run) &&
        run.view.completion?.status === 'reported' &&
        run.bridge?.clears === run.farewellClears
      ) {
        run.mark = 'farewell_' + randomUUID();
        run.bridge.queueMark(run.mark);
      }
    });
  }
  playbackCleared(run: Run) {
    if (run.mark) run.bridge?.cancelMark(run.mark);
    run.mark = undefined;
    clearTimeout(run.farewellTimer);
  }
  clean(run: Run) {
    for (const t of run.timers) clearTimeout(t);
    run.timers.clear();
    clearInterval(run.silenceTimer);
    run.bridge?.dispose();
    run.live?.close();
    run.media?.close();
    run.view.mediaConnected = false;
  }
  finish(run: Run, reason: string) {
    if (run !== this.current) return;
    run.view.status = 'ended';
    run.view.blocked = false;
    run.view.endedAt = Date.now();
    run.stopRequested = true;
    this.clean(run);
    this.log(run, 'ended', reason);
  }
  async stop(reason = '수동 종료') {
    const run = this.current;
    if (!run.view.blocked) return this.public();
    run.stopRequested = true;
    run.live?.cancelReply();
    if (run.dialPending) {
      this.log(run, 'stop_pending', '발신 결과를 받으면 즉시 종료합니다.');
      return this.public();
    }
    if (!run.view.dialSent) {
      this.finish(run, '발신 전 종료');
      return this.public();
    }
    if (!run.view.callControlId) {
      run.view.status = 'unknown';
      this.clean(run);
      this.log(
        run,
        'unknown',
        '통화 ID가 없어 종료를 확인할 수 없습니다. Telnyx 확인이 필요합니다.',
      );
      return this.public();
    }
    if (run.hangupSent) return this.public();
    run.hangupSent = true;
    run.view.status = 'ending';
    this.clean(run);
    this.log(run, 'ending', reason);
    try {
      await this.telnyx(
        run,
        `/calls/${encodeURIComponent(run.view.callControlId)}/actions/hangup`,
        { command_id: randomUUID() },
      );
      if (run.view.blocked) {
        this.log(
          run,
          'hangup_accepted',
          '종료 명령 접수. 서명된 call.hangup 최종 확인을 기다립니다.',
        );
        this.after(run, 12000, () => {
          if (run.view.blocked) {
            run.view.status = 'unknown';
            this.error(
              run,
              new AppError('hangup_unconfirmed', '통신사 최종 종료 이벤트 미확인', 502),
            );
            this.log(
              run,
              'unknown',
              '종료 명령은 접수됐지만 실제 종료를 확인하지 못해 잠금을 유지합니다.',
            );
          }
        });
      }
    } catch (error) {
      if (run.view.blocked) {
        run.view.status = 'unknown';
        this.error(run, error);
        this.log(run, 'unknown', '종료 실패 또는 결과 불명. 새 발신은 잠겨 있습니다.');
      }
    }
    return this.public();
  }
  resolveUnknown(confirmed: unknown) {
    const run = this.current;
    if (run.view.status !== 'unknown' || run.dialPending || confirmed !== true)
      throw new AppError(
        'confirmation_required',
        'Telnyx에서 실제 종료를 확인해야 잠금을 해제할 수 있습니다.',
        409,
      );
    run.view.error = null;
    this.finish(run, '운영자가 통신사 종료를 직접 확인했습니다.');
    return this.public();
  }
  dispose() {
    this.disposed = true;
    this.clean(this.current);
    this.current.live?.dispose();
  }
}
