import { join } from 'node:path';
import { apiCheckContext } from './api-check-context.ts';
import { LiveConnection } from '../src/live.ts';
import { writePrivate } from '../src/config.ts';
const { store, dataDir } = apiCheckContext();
const live = new LiveConnection(store.value, 'resident');
let input: NodeJS.Timeout | undefined, deadline: NodeJS.Timeout | undefined;
let outputBytes = 0,
  transcript = '';
try {
  const done = new Promise<void>((resolve, reject) => {
    live.on('fault', reject);
    live.on('event', (event) => {
      if (event.type === 'session.output_audio.delta')
        outputBytes += Buffer.from(event.delta, 'base64').length;
      if (event.type === 'session.output_transcript.delta') transcript += event.delta;
      if (outputBytes > 160 && transcript.trim()) resolve();
    });
    deadline = setTimeout(
      () => reject(new Error('20초 내 음성 출력과 전사를 확인하지 못했습니다.')),
      20000,
    );
  });
  void done.catch(() => {});
  await live.waitReady();
  input = setInterval(
    () =>
      live.send({
        type: 'session.input_audio.append',
        audio: Buffer.alloc(160, 255).toString('base64'),
      }),
    20,
  );
  live.greet('resident');
  await done;
  const report = {
    checkedAt: Date.now(),
    model: store.value.LIVE_MODEL,
    backendModel: store.value.BACKEND_MODEL,
    sessionStarted: true,
    audioOutputBytes: outputBytes,
    transcriptReceived: !!transcript,
    source: 'silence_input_and_ai_greeting',
    microphoneTested: false,
    webrtcTested: false,
    telnyxUsed: false,
    playbackMarkTested: false,
  };
  writePrivate(join(dataDir, 'voice-api-check.json'), report);
  console.log(JSON.stringify(report, null, 2));
} finally {
  clearInterval(input);
  clearTimeout(deadline);
  live.close();
  setTimeout(() => live.dispose(), 5500).unref();
}
