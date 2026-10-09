import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type WebSocket from 'ws';
import { apiCheckContext } from './api-check-context.ts';
import { ConfigStore, writePrivate } from '../src/config.ts';
import { CallManager } from '../src/calls.ts';
import { muLawRms } from '../src/media.ts';
const { store, dataDir } = apiCheckContext();
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
let speechResolve!: () => void;
const speech = new Promise<void>((resolve) => (speechResolve = resolve));
class LocalPlayback extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  send(raw: string) {
    const event = JSON.parse(raw);
    if (
      event.event === 'media' &&
      !firstSpeechAt &&
      muLawRms(Buffer.from(event.media.payload, 'base64')) > 100
    ) {
      firstSpeechAt = Date.now();
      speechResolve();
    }
  }
  close() {
    this.readyState = 3;
    this.emit('close');
  }
}
const manager = new CallManager(isolated, dir, {
  // The phone provider is a local stub; only OpenAI's Live WebSocket uses the network.
  fetcher: async (url) => {
    if (String(url) !== 'https://api.telnyx.com/v2/calls')
      throw new Error('Unexpected HTTP request');
    return Response.json({ data: { call_control_id: 'local-check-only' } });
  },
});
let deadline: NodeJS.Timeout | undefined;
let carrierInputTimer: NodeJS.Timeout | undefined;
let carrierFrames = 0;
let maxPendingPackets = 0;
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
  const report = {
    checkedAt: Date.now(),
    liveModel: isolated.value.LIVE_MODEL,
    input: 'silence_only',
    preparationMs,
    firstPlaybackPacketAfterAnswerMs: latencyMs,
    carrierFrames,
    forwardedInputSeconds,
    maxPendingPackets,
    telnyxUsed: false,
    transport: 'local_playback_stub',
    handsetPlaybackTested: false,
  };
  writePrivate(join(dataDir, 'phone-opening-check.json'), report);
  console.log(JSON.stringify(report));
} finally {
  clearTimeout(deadline);
  clearInterval(carrierInputTimer);
  manager.dispose();
  rmSync(dir, { recursive: true, force: true });
}
