import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type WebSocket from 'ws';
import { apiCheckContext } from './api-check-context.ts';
import { ConfigStore, writePrivate } from '../src/config.ts';
import { CallManager } from '../src/calls.ts';
import { LiveConnection } from '../src/live.ts';
import { muLawRms, validAudio } from '../src/media.ts';
import {
  classifyStandbyCompletion,
  standbyFarewell,
  standbyQuestions,
} from '../src/standby-completion.ts';
import type { Transcript } from '../src/evacuation.ts';

const { store, dataDir } = apiCheckContext();
if (process.argv.includes('--audio') && !process.argv.includes('--voice'))
  throw new Error('--audio 검사는 --voice와 함께 실행하세요.');
const context: Transcript[] = [
  { speaker: 'assistant', text: standbyQuestions.participation },
  { speaker: 'user', text: '어, 네. 지금 참여 가능합니다. 지금 어디로 이동하면 될까요' },
  { speaker: 'assistant', text: '좋습니다. 그럼 차량 이용이 가능하신가요?' },
  { speaker: 'user', text: '네, 렉스턴 차량 이용할게요' },
  { speaker: 'assistant', text: '네, 감사합니다. 출발까지 얼마나 걸리시나요?' },
];
const latest = '지금 바로 출발하겠습니다';
const cases = [
  { name: 'captured_ready', context, text: latest, expected: 'ready' },
  {
    name: 'participation_only',
    context: context.slice(0, 1),
    text: context[1].text,
    expected: 'pending',
  },
  {
    name: 'vehicle_missing',
    context: [context[0], context[1], context[4]],
    text: latest,
    expected: 'pending',
  },
  {
    name: 'readiness_unknown',
    context,
    text: '아직 얼마나 걸릴지 모르겠어요',
    expected: 'pending',
  },
  {
    name: 'unavailable',
    context: context.slice(0, 1),
    text: '오늘은 참여할 수 없습니다',
    expected: 'unavailable',
  },
  {
    name: 'corrected',
    context: [...context, { speaker: 'user' as const, text: latest }],
    text: '아니요 오늘은 참여할 수 없어요',
    expected: 'unavailable',
  },
];
const results = await Promise.all(
  cases.map(async (item) => {
    const began = Date.now();
    try {
      const result = await classifyStandbyCompletion(store.value, item.text, item.context);
      const actual = result?.state ?? 'pending';
      return {
        name: item.name,
        expected: item.expected,
        actual,
        passed: actual === item.expected,
        latencyMs: Date.now() - began,
      };
    } catch {
      return {
        name: item.name,
        expected: item.expected,
        actual: 'api_unconfirmed',
        passed: false,
        latencyMs: Date.now() - began,
      };
    }
  }),
);
console.log(JSON.stringify({ results }));

async function syntheticReplies() {
  const live = new LiveConnection(store.value, 'standby', undefined, '', undefined, true);
  let failure: Error | undefined;
  let audio: Buffer[] = [];
  let transcript = '';
  let lastSpeech = 0;
  live.on('fault', (error) => (failure = error));
  live.on('event', (event) => {
    if (event.type === 'session.output_audio.delta' && validAudio(event.delta)) {
      const frame = Buffer.from(event.delta, 'base64');
      if (muLawRms(frame) > 100) lastSpeech = Date.now();
      if (lastSpeech && Date.now() - lastSpeech < 300) audio.push(frame);
    }
    if (event.type === 'session.output_transcript.delta') transcript += event.delta ?? '';
  });
  const ticker = setInterval(() => {
    live.send({
      type: 'session.input_audio.append',
      audio: Buffer.alloc(160, 255).toString('base64'),
    });
  }, 20);
  const normalize = (value: string) => value.replace(/\s|[.!?,]/g, '');
  try {
    await live.waitReady();
    const replies: Buffer[] = [];
    for (const line of ['네 지금 이동 가능합니다', '네 렉스턴 차량 이용할게요', latest]) {
      audio = [];
      transcript = '';
      lastSpeech = 0;
      live.say(line);
      const until = Date.now() + 20000;
      while (
        !normalize(transcript).includes(normalize(line)) ||
        !lastSpeech ||
        Date.now() - lastSpeech < 700
      ) {
        if (failure || Date.now() >= until)
          throw new Error('Synthetic Korean reply voice unconfirmed');
        await new Promise<void>((resolve) => setTimeout(resolve, 40));
      }
      const buffer = Buffer.concat(audio);
      if (!buffer.length || buffer.length > 80000)
        throw new Error('Synthetic reply audio size invalid');
      replies.push(buffer);
    }
    return replies;
  } finally {
    clearInterval(ticker);
    live.close();
    setTimeout(() => live.dispose(), 5500).unref();
  }
}

async function checkVoiceClosing() {
  const spokenReplies = process.argv.includes('--audio') ? await syntheticReplies() : undefined;
  const dir = mkdtempSync(join(tmpdir(), 'onmaul-standby-check-'));
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
  let speechAt = 0;
  let firstSpeechAt = 0;
  let hangups = 0;
  class LocalPlayback extends EventEmitter {
    readyState = 1;
    bufferedAmount = 0;
    send(raw: string) {
      const event = JSON.parse(raw);
      if (event.event === 'media' && muLawRms(Buffer.from(event.media.payload, 'base64')) > 100) {
        speechAt = Date.now();
        firstSpeechAt ||= speechAt;
      }
      if (event.event === 'mark') queueMicrotask(() => this.emit('message', Buffer.from(raw)));
    }
    close() {
      this.readyState = 3;
      this.emit('close');
    }
  }
  const manager = new CallManager(isolated, dir, {
    fetcher: async (url, options) => {
      if (String(url) === 'https://api.openai.com/v1/responses') return fetch(url, options);
      if (String(url) === 'https://api.telnyx.com/v2/calls')
        return Response.json({ data: { call_control_id: 'local-standby-check' } });
      if (String(url) === 'https://api.telnyx.com/v2/calls/local-standby-check/actions/hangup') {
        hangups++;
        queueMicrotask(() =>
          manager.webhook({
            data: {
              id: 'check-end',
              event_type: 'call.hangup',
              payload: {
                client_state: manager.current.clientState,
                call_control_id: 'local-standby-check',
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
  const liveEventCounts: Record<string, number> = {};
  async function waitFor(check: () => boolean, ms: number) {
    const end = Date.now() + ms;
    while (!check()) {
      if (manager.public().error || Date.now() >= end)
        throw new Error(
          JSON.stringify({
            failure: 'standby_closing_unconfirmed',
            status: manager.public().status,
            error: manager.public().error?.code,
            completion: manager.public().completion?.kind,
            userTranscripts: manager.public().transcript.filter((t) => t.speaker === 'user').length,
            inputBytes: manager.current.bridge?.inputBytes,
            dropped: manager.current.bridge?.dropped,
            liveEventCounts,
          }),
        );
      await new Promise<void>((resolve) => setTimeout(resolve, 40));
    }
  }
  try {
    const preparingAt = Date.now();
    await manager.start({ consent: true, scenario: 'standby' });
    manager.current.live!.on('event', (event) => {
      liveEventCounts[event.type] = (liveEventCounts[event.type] ?? 0) + 1;
    });
    const preparationMs = Date.now() - preparingAt;
    if (!manager.current.openingReady) throw new Error('Standby opening not prepared before dial');
    const media = new LocalPlayback();
    let inputChunk = 0;
    async function replyWithAudio(index: number) {
      const audio = spokenReplies![index];
      for (let offset = 0; offset < audio.length; offset += 160) {
        const frame = Buffer.alloc(160, 255);
        audio.copy(frame, 0, offset, offset + 160);
        media.emit(
          'message',
          Buffer.from(
            JSON.stringify({
              event: 'media',
              media: {
                track: 'inbound',
                chunk: String((inputChunk += process.argv.includes('--gaps') ? 2 : 1)),
                payload: frame.toString('base64'),
              },
            }),
          ),
        );
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      }
    }
    manager.attachMedia(media as unknown as WebSocket);
    media.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          event: 'start',
          start: {
            client_state: manager.current.clientState,
            call_control_id: 'local-standby-check',
            media_format: { encoding: 'PCMU', sample_rate: 8000, channels: 1 },
          },
        }),
      ),
    );
    const answeredAt = Date.now();
    manager.webhook({
      data: {
        id: 'check-answer',
        event_type: 'call.answered',
        payload: {
          client_state: manager.current.clientState,
          call_control_id: 'local-standby-check',
        },
      },
    });
    await waitFor(() => speechAt > 0 && Date.now() - speechAt > 500, 15000);
    const firstPlaybackAfterAnswerMs = firstSpeechAt - answeredAt;
    if (
      firstPlaybackAfterAnswerMs < 2000 ||
      firstPlaybackAfterAnswerMs > 3000 ||
      manager.public().transcript.some((t) => t.speaker === 'user')
    )
      throw new Error('Opening before receiver reply unconfirmed');
    // Feed actual synthetic PCMU speech through the same media handler when --audio is selected.
    let replyIndex = 0;
    for (const [reply, question] of [
      [context[1].text, standbyQuestions.vehicle],
      [context[3].text, standbyQuestions.readiness],
    ]) {
      const sentAt = Date.now();
      if (spokenReplies) await replyWithAudio(replyIndex++);
      else
        manager.liveEvent(manager.current, {
          type: 'session.input_transcript.delta',
          delta: reply,
        });
      await waitFor(
        () => manager.current.questionLine === question && manager.current.questionSpoken,
        15000,
      );
      await waitFor(
        () =>
          speechAt > sentAt &&
          Date.now() - speechAt > 500 &&
          manager.current.bridge!.output.length < 1600,
        15000,
      );
    }
    const began = Date.now();
    if (spokenReplies) await replyWithAudio(replyIndex);
    else
      manager.liveEvent(manager.current, { type: 'session.input_transcript.delta', delta: latest });
    await waitFor(() => manager.public().status === 'ended', 25000);
    const view = manager.public();
    const assistant = view.transcript
      .filter((t) => t.speaker === 'assistant')
      .map((t) => t.text)
      .join('')
      .replace(/\s|[.!?,]/g, '');
    const allQuestionsPlayedOnce = Object.values(standbyQuestions).every(
      (question) => assistant.split(question.replace(/\s|[.!?,]/g, '')).length - 1 === 1,
    );
    if (
      hangups !== 1 ||
      view.completion?.kind !== 'standby' ||
      !view.completion.playbackConfirmed ||
      !assistant.includes(standbyFarewell.replace(/\s|[.!?,]/g, '')) ||
      !allQuestionsPlayedOnce
    )
      throw new Error('Single hangup or closing playback unconfirmed');
    return {
      kind: view.completion.kind,
      playbackConfirmed: true,
      finalStatus: view.status,
      hangupRequests: hangups,
      replyToEndedMs: Date.now() - began,
      preparationMs,
      firstPlaybackAfterAnswerMs,
      openingBeforeReceiverReply: true,
      allQuestionsPlayedOnce,
      asrTested: !!spokenReplies,
      source: spokenReplies ? 'synthetic_pcmu_audio' : 'synthetic_transcript',
      chunkGapsSimulated: !!spokenReplies && process.argv.includes('--gaps'),
      userTranscripts: view.transcript.filter((t) => t.speaker === 'user').length,
      inputBytes: manager.current.bridge?.inputBytes,
      inputSignalBytes: manager.current.bridge?.inputSignalBytes,
      dropped: manager.current.bridge?.dropped,
      liveEventCounts,
      telnyxUsed: false,
      handsetPlaybackTested: false,
      transport: 'local_playback_stub',
    };
  } finally {
    manager.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
}
const closing = process.argv.includes('--voice') ? await checkVoiceClosing() : undefined;
const report = {
  checkedAt: Date.now(),
  backendModel: store.value.BACKEND_MODEL,
  classificationSource: 'synthetic_transcript',
  results,
  closing,
  telnyxUsed: false,
};
writePrivate(join(dataDir, 'standby-completion-check.json'), report);
console.log(JSON.stringify({ closing }));
if (results.some((row) => !row.passed)) process.exitCode = 1;
