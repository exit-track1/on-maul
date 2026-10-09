import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { apiCheckContext } from './api-check-context.ts';
import { LiveConnection } from '../src/live.ts';
import { classifyEvacuation } from '../src/evacuation.ts';
import { writePrivate } from '../src/config.ts';
const { store, dataDir } = apiCheckContext();
const argument = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const path = argument('--audio'),
  source = argument('--source');
if (!path || !['synthetic', 'microphone_recording'].includes(source ?? ''))
  throw new Error(
    '--audio <raw.pcmu> --source synthetic|microphone_recording가 필요합니다. WAV/RTP 헤더 없는 8kHz mono μ-law 파일만 사용하세요.',
  );
const audio = readFileSync(path);
if (audio.length < 160 || audio.length > 160000 || audio.subarray(0, 4).toString() === 'RIFF')
  throw new Error('20초 이하 raw PCMU 파일이 필요합니다.');
const live = new LiveConnection(store.value, 'resident');
let ticker: NodeJS.Timeout | undefined,
  deadline: NodeJS.Timeout | undefined,
  settle: NodeJS.Timeout | undefined,
  text = '',
  offset = 0;
try {
  const done = new Promise<void>((resolve, reject) => {
    live.on('fault', reject);
    live.on('event', (event) => {
      if (event.type === 'session.input_transcript.delta') {
        text += event.delta;
        clearTimeout(settle);
        settle = setTimeout(resolve, 1500);
      }
    });
    deadline = setTimeout(
      () => reject(new Error('45초 내 입력 전사를 확인하지 못했습니다.')),
      45000,
    );
  });
  void done.catch(() => {});
  await live.waitReady();
  ticker = setInterval(() => {
    const frame = Buffer.alloc(160, 255);
    if (offset < audio.length) {
      audio.copy(frame, 0, offset, offset + 160);
      offset += 160;
    }
    live.send({ type: 'session.input_audio.append', audio: frame.toString('base64') });
  }, 20);
  await done;
  const classification = await classifyEvacuation(store.value, text, []),
    report = {
      checkedAt: Date.now(),
      liveModel: store.value.LIVE_MODEL,
      backendModel: store.value.BACKEND_MODEL,
      source,
      transport: 'websocket_recorded_pcmu',
      inputTranscriptReceived: !!text,
      classificationPassed: !!classification,
      liveMicrophoneTested: false,
      webrtcTested: false,
      telnyxUsed: false,
      playbackMarkTested: false,
    };
  writePrivate(join(dataDir, 'live-classification-check.json'), report);
  console.log(JSON.stringify(report, null, 2));
  if (!classification) process.exitCode = 1;
} finally {
  clearInterval(ticker);
  clearTimeout(deadline);
  clearTimeout(settle);
  live.close();
  setTimeout(() => live.dispose(), 5500).unref();
}
