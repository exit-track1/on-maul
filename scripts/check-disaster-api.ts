import { join } from 'node:path';
import { apiCheckContext } from './api-check-context.ts';
import { classifyEvacuation } from '../src/evacuation.ts';
import { writePrivate } from '../src/config.ts';
const { store, dataDir } = apiCheckContext();
const text = '온빛 배움학교에 도착했어요. 지금 학교에 있어요.';
const classification = await classifyEvacuation(store.value, text, []);
const report = {
  checkedAt: Date.now(),
  model: store.value.BACKEND_MODEL,
  source: 'synthetic_text',
  classificationPassed: !!classification,
  evidenceExact: classification ? text.includes(classification.evidence) : false,
  telnyxUsed: false,
  microphoneTested: false,
  webrtcTested: false,
  playbackMarkTested: false,
};
writePrivate(join(dataDir, 'disaster-api-check.json'), report);
console.log(JSON.stringify(report, null, 2));
if (!classification) process.exitCode = 1;
