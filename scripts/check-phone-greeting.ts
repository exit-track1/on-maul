import { join } from 'node:path';
import { apiCheckContext } from './api-check-context.ts';
import { LiveConnection } from '../src/live.ts';
import { muLawRms } from '../src/media.ts';
import { writePrivate } from '../src/config.ts';
const { store, dataDir } = apiCheckContext();
const live = new LiveConnection(store.value, 'resident', undefined, '', undefined, true);
let ticker: NodeJS.Timeout | undefined;
let deadline: NodeJS.Timeout | undefined;
let text = '';
let speech = false;
let accepted = false;
let beganAt = 0;
try {
  const done = new Promise<void>((resolve, reject) => {
    live.on('fault', reject);
    live.on('instruction-accepted', () => (accepted = true));
    live.on('event', (e) => {
      if (e.type === 'session.output_transcript.delta') text += e.delta;
      if (e.type === 'session.output_audio.delta')
        speech ||= muLawRms(Buffer.from(e.delta, 'base64')) > 100;
      if (accepted && speech && text.replace(/\s/g, '').includes('지금어디십니까')) resolve();
    });
    deadline = setTimeout(() => reject(new Error('20초 내 첫 질문 음성 미확인')), 20000);
  });
  void done.catch(() => {});
  await live.waitReady();
  ticker = setInterval(() => {
    live.send({
      type: 'session.input_audio.append',
      audio: Buffer.alloc(160, 255).toString('base64'),
    });
  }, 20);
  beganAt = Date.now();
  live.greet('resident');
  await done;
  const report = {
    checkedAt: Date.now(),
    liveModel: store.value.LIVE_MODEL,
    input: 'silence_only',
    instructionAccepted: accepted,
    openingQuestionAudioReceived: speech,
    openingQuestionTranscriptMatched: true,
    latencyMs: Date.now() - beganAt,
    telnyxUsed: false,
    handsetPlaybackTested: false,
  };
  writePrivate(join(dataDir, 'phone-greeting-check.json'), report);
  console.log(JSON.stringify(report));
} finally {
  clearInterval(ticker);
  clearTimeout(deadline);
  live.close();
  setTimeout(() => live.dispose(), 5500).unref();
}
