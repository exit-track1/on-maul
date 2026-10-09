import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { ConfigStore, writePrivate } from './config.ts';
import { CallManager } from './calls.ts';
import { callbackServer } from './callbacks.ts';
import { AppError, redact } from './domain.ts';
import { body, json, localRequestPath, EventStream } from './local-http.ts';
import { loadEnvironment, runtimeSettings } from './runtime-env.ts';
import { acquireProcessLock } from './process-lock.ts';
import { Tunnel } from './tunnel.ts';
import { publicProbe } from './public-probe.ts';
import { checkModelAccess, checkConnection } from './model-access.ts';
import type { SocketFactory } from './live.ts';
import { VoiceDemo } from './voice-demo.ts';
import { DisasterEngine } from './disaster.ts';
export function createApplication(
  root: string,
  options: {
    env?: Record<string, string | undefined>;
    fetcher?: typeof fetch;
    socketFactory?: SocketFactory;
  } = {},
) {
  const settings = runtimeSettings(root, options.env ?? process.env),
    store = new ConfigStore(settings.dataDir, options.env ?? process.env),
    release = acquireProcessLock(settings.dataDir);
  const calls = new CallManager(store, settings.dataDir, options),
    voice = new VoiceDemo(store, options.fetcher, options.socketFactory),
    engine = new DisasterEngine(root, settings.dataDir, store, options.fetcher);
  const token = randomBytes(32).toString('hex'),
    probeToken = randomBytes(32).toString('hex');
  const callback = callbackServer(calls, probeToken),
    tunnel = new Tunnel(settings.tunnelBinary, settings.callbackPort),
    events = new EventStream(),
    voiceEvents = new EventStream();
  let reservation = false,
    preparingCall = false,
    cancelPreflight = false,
    closed = false,
    phoneCallId: string | undefined,
    voiceCallId: string | undefined,
    voiceBuffer = '',
    voiceGeneration = 0,
    voiceInputTimer: NodeJS.Timeout | undefined;
  const busy = () => reservation || calls.busy() || voice.busy();
  const unlocked = () => {
    if (busy())
      throw new AppError(
        'actual_voice_locked',
        '진행 중이거나 종료 미확인인 실제 음성 통화가 있습니다.',
        409,
      );
  };
  calls.on('update', (state) => {
    events.publish(state);
    if (state.status === 'ended' && state.completion) {
      try {
        engine.afterCall({
          callId: state.id,
          sessionId: state.sessionId,
          phone: state.phone,
          scenario: state.scenario,
          completion: state.completion,
          callStatus: state.status,
          endedAt: state.endedAt,
        });
      } catch {
        console.error('통화 후속 요청 저장 실패. 종료된 통화 결과로 재시작 시 재처리합니다.');
      }
    }
    if (!state.blocked && phoneCallId) {
      engine.end(phoneCallId);
      phoneCallId = undefined;
    }
  });
  for (const outcome of calls.outcomeStore.list()) engine.afterCall(outcome);
  voice.on('update', (state) => {
    voiceEvents.publish(state);
    if (!state.blocked && voiceCallId) {
      engine.end(voiceCallId);
      voiceCallId = undefined;
      voiceGeneration++;
    }
  });
  voice.on('trusted-transcript', ({ id, event }) => {
    if (!voiceCallId || event.type !== 'session.input_transcript.delta') return;
    voiceBuffer += event.delta;
    const generation = ++voiceGeneration;
    clearTimeout(voiceInputTimer);
    const linkedId = voiceCallId;
    voiceInputTimer = setTimeout(() => {
      const text = voiceBuffer;
      voiceBuffer = '';
      void engine
        .classify(
          linkedId,
          text,
          voice
            .public()
            .transcript.filter((t) => t.speaker === 'user' || t.speaker === 'assistant') as {
            speaker: 'user' | 'assistant';
            text: string;
          }[],
          () =>
            voice.busy() &&
            voice.public().id === id &&
            voiceGeneration === generation &&
            voiceCallId === linkedId,
        )
        .catch(() => {});
    }, 1500);
  });
  const probe = () => publicProbe(store.value.PUBLIC_BASE_URL, probeToken, options.fetcher);
  const files: Record<string, [string, string]> = {
    '/telnyx': ['index.html', 'text/html'],
    '/': ['control.html', 'text/html'],
    '/voice': ['voice.html', 'text/html'],
    '/app.js': ['app.js', 'text/javascript'],
    '/control.js': ['control.js', 'text/javascript'],
    '/voice.js': ['voice.js', 'text/javascript'],
    '/style.css': ['style.css', 'text/css'],
    '/common.js': ['common.js', 'text/javascript'],
  };
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; media-src 'self' blob:; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    try {
      const path = localRequestPath(req, settings.port, token);
      if (req.method === 'GET') {
        if (path === '/api/bootstrap')
          return json(res, 200, {
            token,
            config: store.public(),
            call: calls.public(),
            voice: voice.public(),
            tunnel: tunnel.public(),
            pending: reservation,
            runtime: { environment: settings.environment, callbackPort: settings.callbackPort },
          });
        if (path === '/api/health')
          return json(res, 200, {
            ok: true,
            service: '온 마을 로컬 PoC',
            externalConnectionVerified: false,
          });
        if (path === '/api/calls/outcomes')
          return json(res, 200, { outcomes: calls.outcomeStore.list() });
        if (path === '/api/events') {
          events.subscribe(req, res, calls.public());
          return;
        }
        if (path === '/api/voice/events') {
          voiceEvents.subscribe(req, res, voice.public());
          return;
        }
        if (path === '/api/voice/state') return json(res, 200, voice.public());
        if (path === '/api/disaster/state' || path === '/api/disaster/export')
          return json(res, 200, engine.public());
        if (files[path]) {
          const [file, mime] = files[path];
          res.writeHead(200, { 'Content-Type': mime + '; charset=utf-8' });
          res.end(readFileSync(join(root, 'public', file)));
          return;
        }
      }
      if (req.method === 'POST') {
        const input = await body(req, path === '/api/recordings' ? 16 * 1024 * 1024 : 65536);
        if (path === '/api/config') {
          unlocked();
          return json(res, 200, { config: store.save(input) });
        }
        if (path === '/api/models/check') {
          unlocked();
          return json(res, 200, await checkModelAccess(store, options.fetcher));
        }
        if (path === '/api/connection/check') {
          unlocked();
          reservation = true;
          try {
            const result = await checkConnection(store, options.fetcher, options.socketFactory);
            try {
              result.checks.push(await probe());
            } catch (error) {
              result.checks.push({
                name: '공개 콜백',
                ok: false,
                message: error instanceof AppError ? error.message : '콜백 HTTPS 경로 접근 미확인',
              });
            }
            return json(res, 200, JSON.parse(redact(JSON.stringify(result), store.secrets())));
          } finally {
            reservation = false;
          }
        }
        if (path === '/api/callback/check') {
          unlocked();
          reservation = true;
          try {
            return json(res, 200, {
              check: await probe(),
              note: '공개 콜백만 검사했습니다. OpenAI·Telnyx API 호출과 발신은 없습니다.',
            });
          } finally {
            reservation = false;
          }
        }
        if (path === '/api/tunnel/start') {
          unlocked();
          if (settings.environment !== 'local')
            throw new AppError(
              'local_tunnel_only',
              '배포 환경에서는 배포 도메인의 콜백 경로를 사용하세요.',
              409,
            );
          if (store.env.PUBLIC_BASE_URL)
            throw new AppError(
              'public_url_environment_override',
              '환경 파일의 PUBLIC_BASE_URL을 비우고 재시작해야 로컬 터널 URL을 적용할 수 있습니다.',
              409,
            );
          reservation = true;
          try {
            const url = await tunnel.start();
            store.save({ PUBLIC_BASE_URL: url });
            return json(res, 200, { config: store.public(), tunnel: tunnel.public() });
          } finally {
            reservation = false;
          }
        }
        if (path === '/api/tunnel/stop') {
          unlocked();
          tunnel.stop();
          return json(res, 200, { tunnel: tunnel.public() });
        }
        if (path === '/api/calls') {
          unlocked();
          const linked = input.callId ? engine.linked(String(input.callId), 'telnyx') : null;
          const params = { ...input, scenario: linked?.scenario ?? input.scenario };
          calls.validateStart(params);
          reservation = true;
          preparingCall = true;
          cancelPreflight = false;
          try {
            await probe();
            if (cancelPreflight)
              throw new AppError('call_cancelled', '공개 연결 검사 중 발신을 취소했습니다.', 409);
            const call = await calls.start(
              params,
              linked
                ? {
                    link: { targetId: linked.targetId, scenarioCallId: linked.id },
                    context: `가상 대상 ${linked.targetId}. 등록 대피소: ${engine.state.shelters
                      .filter((s) => s.open)
                      .map((s) => s.name)
                      .join(', ')}`,
                    beforeDial: async () => {
                      engine.bind(linked.id, calls.public().sessionId!, 'telnyx');
                      phoneCallId = linked.id;
                    },
                    classifier: async (_config, text, context, valid) =>
                      engine.classify(linked.id, text, context, valid),
                  }
                : {},
            );
            if (linked && !call.blocked) engine.end(linked.id);
            return json(res, 200, { call });
          } finally {
            reservation = false;
            preparingCall = false;
          }
        }
        if (path === '/api/calls/hangup') {
          if (preparingCall && !calls.busy()) cancelPreflight = true;
          return json(res, 200, { call: await calls.stop() });
        }
        if (path === '/api/calls/resolve')
          return json(res, 200, { call: calls.resolveUnknown(input.confirmedEnded) });
        if (path === '/api/voice/session') {
          unlocked();
          const linked = input.callId ? engine.linked(String(input.callId), 'browser') : null;
          reservation = true;
          try {
            const answer = await voice.start(
              { ...input, scenario: linked?.scenario ?? input.scenario },
              linked
                ? `가상 가구 ${linked.targetId}. 대피소 ${engine.state.shelters.map((s) => s.name).join(', ')}`
                : '',
            );
            if (linked) {
              engine.bind(linked.id, answer.sessionId, 'browser');
              voiceCallId = linked.id;
            }
            return json(res, 201, answer);
          } catch (error) {
            if (voice.busy()) voice.stop(voice.public().id);
            throw error;
          } finally {
            reservation = false;
          }
        }
        if (path === '/api/voice/ready') return json(res, 200, voice.ready(input.id));
        if (path === '/api/voice/heartbeat') return json(res, 200, voice.heartbeat(input.id));
        if (path === '/api/voice/hangup') return json(res, 200, voice.stop(String(input.id)));
        if (path === '/api/voice/resolve')
          return json(res, 200, voice.resolve(input.confirmedEnded));
        if (path === '/api/recordings') {
          if (
            input.id !== voice.public().id ||
            !voice.recordingConsent ||
            typeof input.data !== 'string' ||
            !/^[A-Za-z0-9+/]+={0,2}$/.test(input.data) ||
            typeof input.mime !== 'string' ||
            !/^audio\/(webm|ogg|mp4)(?:;codecs=[\w,.-]+)?$/.test(input.mime)
          )
            throw new AppError(
              'recording_not_authorized',
              '이 통화에서 명시적으로 선택한 녹음만 저장할 수 있습니다.',
              403,
            );
          writePrivate(join(settings.dataDir, 'recordings', String(input.id) + '.json'), {
            id: input.id,
            mime: input.mime,
            data: input.data,
            recordedAt: Date.now(),
            consented: true,
          });
          return json(res, 201, { saved: true });
        }
        if (path === '/api/voice/transcripts')
          return json(res, 200, {
            accepted: false,
            source: 'browser_delivery_test',
            note: '브라우저 입력은 자동 안전 판단 근거로 사용하지 않습니다.',
          });
        if (path === '/api/disaster/call') {
          unlocked();
          return json(res, 201, engine.prepare(input));
        }
        if (path === '/api/disaster/cancel') {
          engine.end(String(input.callId));
          return json(res, 200, engine.public());
        }
        if (path.startsWith('/api/disaster/')) {
          unlocked();
          return json(res, 200, engine.command(path.slice('/api/disaster/'.length), input));
        }
      }
      throw new AppError('not_found', '요청 경로가 없습니다.', 404);
    } catch (error) {
      const e =
        error instanceof AppError
          ? error
          : new AppError(
              'server_error',
              '요청 처리에 실패했습니다. 입력과 서버 상태를 확인하세요.',
              500,
            );
      if (!res.headersSent)
        json(res, e.status, {
          error: { code: e.code, message: redact(e.message, store.secrets()), action: e.action },
        });
      else res.end();
    }
  });
  server.requestTimeout = 60000;
  const closeServer = (s: Server) =>
    new Promise<void>((r) => {
      s.close(() => r());
      s.closeAllConnections();
    });
  async function close() {
    if (closed) return;
    closed = true;
    clearTimeout(voiceInputTimer);
    if (calls.busy()) await calls.stop('서버 종료');
    voice.stop(voice.public().id);
    events.close();
    voiceEvents.close();
    calls.dispose();
    voice.dispose();
    tunnel.stop();
    await Promise.all([closeServer(server), closeServer(callback)]);
    release();
  }
  return { server, callback, settings, store, calls, voice, engine, close };
}
const root = dirname(dirname(fileURLToPath(import.meta.url)));
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loadEnvironment(root);
  const app = createApplication(root);
  app.callback.listen(app.settings.callbackPort, '127.0.0.1');
  app.server.listen(app.settings.port, '127.0.0.1', () =>
    console.log(
      `온 마을 PoC: http://localhost:${app.settings.port}/telnyx · 콜백 127.0.0.1:${app.settings.callbackPort}`,
    ),
  );
  for (const s of [app.server, app.callback])
    s.on('error', () => {
      console.error('로컬 포트 실행 실패');
      process.exitCode = 1;
      void app.close();
    });
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => {
      void app.close();
    });
}
