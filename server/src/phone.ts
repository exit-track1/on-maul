import { existsSync, readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import type { Server } from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import { z } from 'zod';
import { CallManager, type CallView } from '../../src/calls.ts';
import { ConfigStore, writePrivate, type Config } from '../../src/config.ts';
import { AppError, normalizePhone, redact } from '../../src/domain.ts';
import { verifyWebhook } from '../../src/callbacks.ts';
import { acquireProcessLock } from '../../src/process-lock.ts';
import { publicProbe } from '../../src/public-probe.ts';
import { outcomeSchema } from '../../src/call-outcomes.ts';
import type { SocketFactory } from '../../src/live.ts';
import type {
  PhoneCall,
  PhoneCompletion,
  PhoneState,
  PhoneTarget,
  PhoneTargetId,
  PhoneUpdate,
} from '../../shared/src/phone.ts';

const definitions = [
  { id: 'H012', name: '반영환 할아버지', scenario: 'resident', env: 'REAL_RESIDENT' },
  { id: 'M01', name: '반영환 대원', scenario: 'standby', env: 'REAL_SQUAD' },
] as const;
const explicitYes = (value?: string) => /^(?:yes|true|1)$/i.test(value?.trim() ?? '');
const callSchema = z.object({
  id: z.uuid(),
  requestId: z.string().min(1).max(200),
  targetId: z.enum(['H012', 'M01']),
  targetName: z.string().max(100),
  scenario: z.enum(['resident', 'standby']),
  providerId: z.string().max(500).nullable(),
  status: z.enum([
    'requesting',
    'created',
    'ringing',
    'answered',
    'ending',
    'ended',
    'failed',
    'unknown',
  ]),
  blocked: z.boolean(),
  requestedAt: z.number().nullable(),
  answeredAt: z.number().nullable(),
  endedAt: z.number().nullable(),
  transcript: z
    .array(
      z.object({
        speaker: z.enum(['assistant', 'user']),
        text: z.string().max(8000),
      }),
    )
    .max(100),
  completion: outcomeSchema.shape.completion.optional(),
  error: z.object({ code: z.string(), message: z.string(), action: z.string() }).optional(),
  notice: z.string(),
});

export interface PhoneEngineOptions {
  root?: string;
  environment?: Record<string, string | undefined>;
  directory?: string;
  settingsDirectory?: string;
  store?: ConfigStore;
  fetcher?: typeof fetch;
  socketFactory?: SocketFactory;
  requestTimeoutMs?: number;
  onUpdate?: (update: PhoneUpdate) => void;
}

export interface PhonePort {
  readonly probeToken: string;
  state(): PhoneState;
  start(
    targetId: PhoneTargetId,
    requestId: string,
    shelterName?: string,
    rescueLocation?: string,
  ): Promise<PhoneCall>;
  stop(callId?: string): Promise<PhoneState>;
  resolveUnknown(callId: string, confirmed: boolean): PhoneState;
  verifyWebhook(raw: Buffer, headers: IncomingHttpHeaders): boolean;
  webhook(event: unknown): void;
  attachUpgrade(server: Server): void;
  on(event: 'update', listener: (update: PhoneUpdate) => void): unknown;
  off(event: 'update', listener: (update: PhoneUpdate) => void): unknown;
  dispose(): void;
}

/** One voice session, with the original PoC's audio bridge and call-end safeguards. */
export class PhoneEngine extends EventEmitter implements PhonePort {
  private callManager?: CallManager;
  readonly probeToken = randomBytes(32).toString('hex');
  readonly enabled: boolean;
  private readonly targets: PhoneTarget[];
  private readonly numbers = new Map<PhoneTargetId, string>();
  private readonly calls = new Map<string, PhoneCall>();
  private readonly providerBindings = new Map<string, string>();
  private readonly path: string;
  private readonly releaseLock?: () => void;
  private readonly onUpdate?: PhoneEngineOptions['onUpdate'];
  private readonly fetcher: typeof fetch;
  private pending?: { target: PhoneTarget; requestId: string };
  private starting = false;
  private cancelStart = false;
  private disposed = false;
  private websocket?: WebSocketServer;
  private server?: Server;
  private historyWarning = '';
  private readonly privateSecrets: string[];

  constructor(options: PhoneEngineOptions = {}) {
    super();
    const root = options.root ?? process.cwd();
    const env = options.environment ?? process.env;
    this.privateSecrets = [env.ON_OPERATOR_TOKEN ?? ''].filter(Boolean);
    const directory =
      options.directory ?? resolve(root, env.ON_PHONE_DATA_DIR || '.data/dashboard-phone');
    this.enabled = env.ON_EXECUTION_MODE === 'hybrid' && explicitYes(env.ON_PHONE_ENABLED);
    this.fetcher = options.fetcher ?? fetch;
    this.onUpdate = options.onUpdate;
    this.path = join(directory, 'phone-history.json');
    const store = this.enabled
      ? (options.store ??
        new ConfigStore(
          options.settingsDirectory ?? resolve(root, env.ON_LOCAL_DATA_DIR || '.data'),
          env,
        ))
      : undefined;
    this.targets = definitions.map((definition) => {
      const testBinding = env.ON_PHONE_TEST_TARGET_ID === definition.id;
      const raw =
        env[`${definition.env}_E164`] ||
        (testBinding ? (store?.value.TEST_PHONE ?? env.TEST_PHONE) : '');
      let number = '';
      try {
        if (raw) number = normalizePhone(raw, true);
      } catch {
        /* shown as unconfigured */
      }
      if (number) this.numbers.set(definition.id, number);
      return {
        id: definition.id,
        name: definition.name,
        scenario: definition.scenario,
        configured: Boolean(number),
        phoneMasked: number ? this.mask(number) : '',
        consent:
          explicitYes(env[`${definition.env}_CONSENT`]) ||
          (testBinding && explicitYes(env.ON_PHONE_TEST_CONSENT)),
      };
    });
    // Demo construction does not read or write the PoC's settings or active-call data.
    if (!this.enabled) return;
    this.releaseLock = acquireProcessLock(directory);
    try {
      this.callManager = new CallManager(store!, directory, options);
      this.loadHistory();
      // CallManager restores a blocked journal as unknown; the prior immutable binding remains.
      this.capture(this.manager.public());
      this.manager.on('update', this.capture);
    } catch (error) {
      this.releaseLock();
      throw error;
    }
  }

  get manager(): CallManager {
    if (!this.callManager)
      throw new AppError('phone_disabled', '실제 전화가 활성화되지 않았습니다.', 409);
    return this.callManager;
  }

  private mask(number: string) {
    return `${number.startsWith('+8210') ? '010' : '+'} •••• ${number.slice(-4)}`;
  }

  private scrub(text: string) {
    let clean = redact(text, [
      ...(this.callManager?.store.secrets() ?? []),
      ...this.privateSecrets,
    ]);
    for (const phone of [
      ...this.numbers.values(),
      this.callManager?.store.value.CALLER_NUMBER,
      this.callManager?.store.value.TEST_PHONE,
      this.callManager?.current.config.TEST_PHONE,
    ].filter(Boolean)) {
      clean = clean.split(phone!).join(this.mask(phone!));
      if (phone!.startsWith('+82')) {
        const domestic = `0${phone!.slice(3)}`;
        clean = clean.split(domestic).join(this.mask(phone!));
      }
    }
    return clean.replace(/(?:\+82[- ]?10|010)[- ]?\d{4}[- ]?\d{4}/g, '[전화번호 가림]');
  }

  private scrubValue<T>(value: T): T {
    if (typeof value === 'string') return this.scrub(value) as T;
    if (Array.isArray(value)) return value.map((item) => this.scrubValue(item)) as T;
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, this.scrubValue(item)]),
      ) as T;
    return value;
  }

  private loadHistory() {
    if (!existsSync(this.path)) return;
    try {
      const history = z
        .array(z.unknown())
        .max(200)
        .parse(JSON.parse(readFileSync(this.path, 'utf8')));
      for (const stored of history) {
        // Old PoC data may contain this assumed rescue subject; never expose it as a phone target.
        if (
          stored &&
          typeof stored === 'object' &&
          'targetId' in stored &&
          stored.targetId === 'H009'
        )
          continue;
        const raw = callSchema.parse(stored);
        const definition = definitions.find((target) => target.id === raw.targetId)!;
        if (raw.scenario !== definition.scenario) throw new Error('history target mismatch');
        const call: PhoneCall = this.scrubValue({ ...raw, targetName: definition.name });
        this.calls.set(call.id, call);
        if (call.providerId) {
          const previous = this.providerBindings.get(call.providerId);
          if (previous && previous !== call.id) throw new Error('history provider mismatch');
          this.providerBindings.set(call.providerId, call.id);
        }
      }
    } catch {
      this.calls.clear();
      this.providerBindings.clear();
      this.historyWarning = '저장된 통화 내역을 읽지 못했습니다. 원본 기록을 확인하세요.';
    }
  }

  private capture = (view: CallView) => {
    if (this.disposed || !view.id || view.status === 'idle') return;
    let previous = this.calls.get(view.id);
    if (!previous && this.pending) {
      previous = {
        id: view.id,
        requestId: this.pending.requestId,
        targetId: this.pending.target.id,
        targetName: this.pending.target.name,
        scenario: this.pending.target.scenario,
        providerId: null,
        status: 'requesting',
        blocked: true,
        requestedAt: view.requestedAt,
        answeredAt: null,
        endedAt: null,
        transcript: [],
        notice: '',
      };
    }
    // An unbound journal can block new calls but cannot be assigned to another resident.
    if (!previous || previous.scenario !== view.scenario) return;
    if (view.callControlId) {
      const bound = this.providerBindings.get(view.callControlId);
      if (bound && bound !== view.id) return;
      if (previous.providerId && previous.providerId !== view.callControlId) return;
      this.providerBindings.set(view.callControlId, view.id);
    }
    const call: PhoneCall = {
      ...previous,
      providerId: view.callControlId,
      status: view.status,
      blocked: view.blocked,
      requestedAt: view.requestedAt,
      answeredAt: view.answeredAt,
      endedAt: view.endedAt,
      // A recovered CallManager journal omits transcripts. Later final events must retain them.
      transcript: view.transcript.length ? view.transcript : previous.transcript,
      notice: view.notice,
      ...(view.completion ? { completion: view.completion as PhoneCompletion } : {}),
      ...(view.error ? { error: view.error } : { error: undefined }),
    };
    const safe = this.scrubValue(call);
    // Audio statistics update at frame frequency. Persist and broadcast only
    // changes that affect the conversation, its result, or its lifecycle.
    if (previous && JSON.stringify(safe) === JSON.stringify(previous)) return;
    this.calls.set(view.id, safe);
    const oldest = [...this.calls.values()].sort(
      (a, b) => (a.requestedAt ?? 0) - (b.requestedAt ?? 0),
    );
    for (const old of oldest.slice(0, Math.max(0, oldest.length - 200))) {
      if (old.blocked || old.id === view.id) continue;
      this.calls.delete(old.id);
      if (old.providerId) this.providerBindings.delete(old.providerId);
    }
    try {
      writePrivate(this.path, [...this.calls.values()]);
    } catch {
      this.historyWarning = '전사 내역 저장에 실패했습니다. 서버 저장 경로를 확인하세요.';
    }
    this.onUpdate?.({ requestId: safe.requestId, call: structuredClone(safe) });
    this.emit('update', {
      requestId: safe.requestId,
      call: structuredClone(safe),
    } satisfies PhoneUpdate);
  };

  private missingSettings(config: Config) {
    return (
      [
        'OPENAI_API_KEY',
        'TELNYX_API_KEY',
        'TELNYX_APPLICATION_ID',
        'TELNYX_PUBLIC_KEY',
        'PUBLIC_BASE_URL',
        'CALLER_NUMBER',
      ] as const
    ).filter((key) => !config[key]);
  }

  state(): PhoneState {
    const missing = this.callManager ? this.missingSettings(this.callManager.store.value) : [];
    const ready =
      this.enabled &&
      !this.disposed &&
      !missing.length &&
      this.targets.some((target) => target.configured && target.consent);
    const busy = this.starting || (this.callManager?.busy() ?? false);
    const notice =
      this.historyWarning ||
      (this.disposed
        ? '전화 연결이 종료되었습니다.'
        : !this.enabled
          ? '실제 전화는 hybrid 모드와 ON_PHONE_ENABLED=yes 설정으로 활성화합니다.'
          : missing.length
            ? `전화 설정 필요: ${missing.join(', ')}`
            : !this.targets.some((target) => target.configured && target.consent)
              ? '대상별 수신 번호와 시연 동의 설정이 필요합니다.'
              : busy
                ? this.manager.public().notice
                : '실제 전화 준비 완료. 동의한 시연 대상에게 발신할 수 있습니다.');
    return {
      enabled: this.enabled,
      ready,
      busy,
      notice: this.scrub(notice),
      targets: structuredClone(this.targets),
      calls: structuredClone(
        [...this.calls.values()].sort((a, b) => (b.requestedAt ?? 0) - (a.requestedAt ?? 0)),
      ),
    };
  }

  async start(
    targetId: PhoneTargetId,
    requestId: string,
    shelterName = '온빛 배움학교',
    rescueLocation?: string,
  ): Promise<PhoneCall> {
    if (!this.enabled || this.disposed)
      throw new AppError('phone_disabled', '실제 전화가 활성화되지 않았습니다.', 409);
    if (this.starting || this.manager.busy())
      throw new AppError('call_locked', '진행 중이거나 종료 미확인인 통화가 있습니다.', 409);
    const target = this.targets.find((candidate) => candidate.id === targetId);
    if (!target || !target.configured || !target.consent)
      throw new AppError('target_not_configured', '동의된 대상별 수신 번호가 필요합니다.', 409);
    if (!requestId || requestId.length > 200)
      throw new AppError('invalid_request_id', '통화 요청 ID가 필요합니다.');
    if ([...this.calls.values()].some((call) => call.requestId === requestId))
      throw new AppError('duplicate_request', '이미 처리한 통화 요청입니다.', 409);
    this.starting = true;
    this.cancelStart = false;
    this.pending = { target, requestId };
    const previous = this.manager.store.value;
    try {
      // Prove that the public callback belongs to this dashboard before creating voice sessions.
      await publicProbe(previous.PUBLIC_BASE_URL, this.probeToken, this.fetcher);
      if (this.cancelStart || this.disposed)
        throw new AppError('call_cancelled', '발신 전 취소되었습니다.', 409);
      this.manager.store.value = { ...previous, TEST_PHONE: this.numbers.get(targetId)! };
      const view = await this.manager.start(
        { scenario: target.scenario, consent: true },
        {
          link: { targetId, scenarioCallId: requestId },
          shelterName,
          standbyQuestion:
            target.scenario === 'standby' && rescueLocation
              ? `박미숙 할머니께서 구조 요청을 하셨습니다. ${rescueLocation}으로 이동 가능하십니까?`
              : undefined,
          context: `통화 대상은 ${target.name}입니다. 대시보드 요청 ID ${requestId}.`,
        },
      );
      this.capture(view);
      const call = this.calls.get(view.id);
      if (!call)
        throw new AppError('call_binding_missing', '통화 대상 연결을 확인하지 못했습니다.', 502);
      return structuredClone(call);
    } finally {
      this.manager.store.value = previous;
      this.pending = undefined;
      this.starting = false;
    }
  }

  async stop(callId?: string): Promise<PhoneState> {
    if (!this.callManager || this.disposed) return this.state();
    if (callId && callId !== this.manager.public().id)
      throw new AppError('call_not_active', '현재 활성 통화 ID가 아닙니다.', 409);
    this.cancelStart = true;
    await this.manager.stop();
    return this.state();
  }

  resolveUnknown(callId: string, confirmed: boolean): PhoneState {
    if (callId !== this.manager.public().id)
      throw new AppError('call_not_active', '현재 종료 미확인 통화 ID가 아닙니다.', 409);
    this.manager.resolveUnknown(confirmed);
    return this.state();
  }

  verifyWebhook(raw: Buffer, headers: IncomingHttpHeaders): boolean {
    return (
      this.enabled &&
      !this.disposed &&
      verifyWebhook(raw, headers, this.manager.current.config.TELNYX_PUBLIC_KEY)
    );
  }

  webhook(event: unknown): void {
    if (this.enabled && !this.disposed) this.manager.webhook(event);
  }

  private upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!request.url?.startsWith('/media/')) return;
    const token = /^\/media\/([a-f0-9]{64})$/.exec(request.url)?.[1];
    if (!this.enabled || this.disposed || !token || !this.callManager?.mediaAllowed(token)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    this.websocket!.handleUpgrade(request, socket, head, (client) =>
      this.manager.attachMedia(client),
    );
  };

  attachUpgrade(server: Server): void {
    if (this.server) {
      if (this.server === server) return;
      throw new Error('전화 미디어 서버가 이미 연결되었습니다.');
    }
    this.server = server;
    this.websocket = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });
    server.on('upgrade', this.upgrade);
  }

  dispose(): void {
    if (this.disposed) return;
    this.callManager?.off('update', this.capture);
    this.callManager?.dispose();
    this.disposed = true;
    this.server?.off('upgrade', this.upgrade);
    for (const client of this.websocket?.clients ?? []) client.terminate();
    this.websocket?.close();
    this.releaseLock?.();
  }
}
