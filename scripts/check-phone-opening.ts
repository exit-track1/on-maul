import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type WebSocket from 'ws';
import { apiCheckContext } from './api-check-context.ts';
import { ConfigStore, writePrivate } from '../src/config.ts';
import { CallManager } from '../src/calls.ts';
import { muLawRms } from '../src/media.ts';
import { residentQuestions, rescueFarewell } from '../src/resident-flow.ts';
const { store, dataDir } = apiCheckContext();
const dialogueCheck = process.argv.includes('--dialogue');
const dir = mkdtempSync(join(tmpdir(), 'onmaul-opening-check-'));
const isolated = new ConfigStore(dir, {});
isolated.save({
  OPENAI_API_KEY: store.value.OPENAI_API_KEY,
  LIVE_MODEL: store.value.LIVE_MODEL,
  BACKEND_MODEL: store.value.BACKEND_MODEL,
  VOICE: store.value.VOICE,
  TELNYX_API_KEY: 'test-no-network',
  TELNYX_APPLICATION_ID: 'test-app',
  TELNYX_PUBLIC_KEY: Buffer.alloc(32, 1).toString('base64'),
  CALLER_NUMBER: '+12025550103',
  TEST_PHONE: '01000000000',
  PUBLIC_BASE_URL: 'https://no-network.trycloudflare.com',
});
let acceptedAt = 0;
let firstSpeechAt = 0;
let lastSpeechAt = 0;
let replyAt = 0;
let firstReplySpeechAt = 0;
let speechResolve!: () => void;
const speech = new Promise<void>((resolve) => (speechResolve = resolve));
class LocalPlayback extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  send(raw: string) {
    const event = JSON.parse(raw);
    if (event.event === 'media' && muLawRms(Buffer.from(event.media.payload, 'base64')) > 100) {
      lastSpeechAt = Date.now();
      if (replyAt && !firstReplySpeechAt) firstReplySpeechAt = lastSpeechAt;
      if (!firstSpeechAt) {
        firstSpeechAt = lastSpeechAt;
        speechResolve();
      }
    }
    if (dialogueCheck && event.event === 'mark')
      queueMicrotask(() => this.emit('message', Buffer.from(raw)));
  }
  close() {
    this.readyState = 3;
    this.emit('close');
  }
}
const manager = new CallManager(isolated, dir, {
  // The phone provider is always a local stub. Dialogue mode also calls real Responses.
  fetcher: async (url, options) => {
    if (String(url) === 'https://api.telnyx.com/v2/calls')
      return Response.json({ data: { call_control_id: 'local-check-only' } });
    if (dialogueCheck && String(url) === 'https://api.openai.com/v1/responses')
      return fetch(url, options);
    if (
      dialogueCheck &&
      String(url) === 'https://api.telnyx.com/v2/calls/local-check-only/actions/hangup'
    ) {
      queueMicrotask(() =>
        manager.webhook({
          data: {
            id: 'check-hangup',
            event_type: 'call.hangup',
            payload: {
              client_state: manager.current.clientState,
              call_control_id: 'local-check-only',
              hangup_cause: 'normal_clearing',
            },
          },
        }),
      );
      return Response.json({ data: {} });
    }
    throw new Error('Unexpected HTTP request');
  },
});
let deadline: NodeJS.Timeout | undefined;
let carrierInputTimer: NodeJS.Timeout | undefined;
let carrierFrames = 0;
let maxPendingPackets = 0;
async function waitFor(check: () => boolean, ms: number) {
  const until = Date.now() + ms;
  while (!check()) {
    if (manager.public().error || Date.now() >= until)
      throw new Error(
        JSON.stringify({
          failure: 'dialogue_progression_unconfirmed',
          outputBufferedMs: (manager.current.bridge?.output.length ?? 0) / 8,
          speechQuietMs: Date.now() - lastSpeechAt,
          status: manager.public().status,
          error: manager.public().error?.code,
        }),
      );
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
  }
}
try {
  const began = Date.now();
  const view = await manager.start({ consent: true, scenario: 'resident' });
  if (!view.dialSent || !manager.current.openingReady)
    throw new Error('Opening audio not prepared');
  const preparationMs = Date.now() - began;
  const media = new LocalPlayback();
  manager.attachMedia(media as unknown as WebSocket);
  media.emit(
    'message',
    Buffer.from(
      JSON.stringify({
        event: 'start',
        start: {
          client_state: manager.current.clientState,
          call_control_id: 'local-check-only',
          media_format: { encoding: 'PCMU', sample_rate: 8000, channels: 1 },
        },
      }),
    ),
  );
  // Match the provider: inbound 20ms packets begin before the answer webhook,
  // then continue throughout the two-second outbound greeting delay.
  carrierInputTimer = setInterval(() => {
    carrierFrames++;
    media.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          event: 'media',
          media: {
            track: 'inbound',
            chunk: carrierFrames,
            payload: Buffer.alloc(160, 255).toString('base64'),
          },
        }),
      ),
    );
    maxPendingPackets = Math.max(maxPendingPackets, manager.current.bridge?.pending.size ?? 0);
  }, 20);
  await new Promise<void>((resolve) => setTimeout(resolve, 350));
  acceptedAt = Date.now();
  manager.webhook({
    data: {
      id: 'check-answer',
      event_type: 'call.answered',
      payload: {
        client_state: manager.current.clientState,
        call_control_id: 'local-check-only',
      },
    },
  });
  await Promise.race([
    speech,
    new Promise<void>(
      (_resolve, reject) =>
        (deadline = setTimeout(
          () => reject(new Error('Cached opening playback unconfirmed')),
          5000,
        )),
    ),
  ]);
  const latencyMs = firstSpeechAt - acceptedAt;
  if (latencyMs < 2000 || latencyMs > 3000) throw new Error('Opening delay outside expected range');
  const forwardedInputSeconds = manager.current.bridge!.inputBytes / 8000;
  if (carrierFrames <= 100 || forwardedInputSeconds < 2 || manager.public().error)
    throw new Error('Continuous inbound audio was not drained through the greeting delay');
  let dialogue:
    | {
        kind?: string;
        initialQuestionCount: number;
        playbackConfirmed: boolean;
        finalStatus: string;
        replyToFirstVoiceMs: number;
      }
    | undefined;
  if (dialogueCheck) {
    clearTimeout(deadline);
    await waitFor(
      () => Date.now() - lastSpeechAt >= 500 && manager.current.bridge!.output.length < 1600,
      15000,
    );
    // Inject the observed recognition error as a synthetic transcript. This tests the
    // app, real classifier and real closing voice together; it does not test ASR.
    replyAt = Date.now();
    manager.liveEvent(manager.current, {
      type: 'session.input_transcript.delta',
      delta: '어 나 지금 모둠지겨요. 차 보내주실 수 있나요',
    });
    await waitFor(
      () =>
        !!manager.public().completion ||
        (manager.current.questionLine === residentQuestions.assistance &&
          manager.current.questionSpoken),
      15000,
    );
    if (!manager.public().completion)
      manager.liveEvent(manager.current, {
        type: 'session.input_transcript.delta',
        delta: '네 차량 지원이 필요해요',
      });
    await waitFor(() => manager.public().status === 'ended', 20000);
    const result = manager.public();
    const assistant = result.transcript
      .filter((item) => item.speaker === 'assistant')
      .map((item) => item.text)
      .join('')
      .replace(/\s|[.!?,]/g, '');
    const initialQuestionCount = assistant.split('현재산불로인하여').length - 1;
    if (
      result.completion?.kind !== 'rescue' ||
      !result.completion.playbackConfirmed ||
      !assistant.includes(rescueFarewell.replace(/\s|[.!?,]/g, '')) ||
      initialQuestionCount !== 1 ||
      !firstReplySpeechAt
    )
      throw new Error('Rescue closing or single opening unconfirmed');
    dialogue = {
      kind: result.completion.kind,
      initialQuestionCount,
      playbackConfirmed: result.completion.playbackConfirmed,
      finalStatus: result.status,
      replyToFirstVoiceMs: firstReplySpeechAt - replyAt,
    };
  }
  const report = {
    checkedAt: Date.now(),
    liveModel: isolated.value.LIVE_MODEL,
    input: 'silence_only',
    preparationMs,
    firstPlaybackPacketAfterAnswerMs: latencyMs,
    carrierFrames,
    forwardedInputSecondsAtFirstPlayback: forwardedInputSeconds,
    forwardedInputSeconds: manager.current.bridge!.inputBytes / 8000,
    maxPendingPackets,
    telnyxUsed: false,
    transport: 'local_playback_stub',
    handsetPlaybackTested: false,
    ...(dialogueCheck ? { replySource: 'synthetic_transcript', asrTested: false, dialogue } : {}),
  };
  writePrivate(
    join(dataDir, dialogueCheck ? 'phone-dialogue-check.json' : 'phone-opening-check.json'),
    report,
  );
  console.log(JSON.stringify(report));
} finally {
  clearTimeout(deadline);
  clearInterval(carrierInputTimer);
  manager.dispose();
  rmSync(dir, { recursive: true, force: true });
}
