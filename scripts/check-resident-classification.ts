import { join } from 'node:path';
import { apiCheckContext } from './api-check-context.ts';
import { classifyResident } from '../src/resident-classifier.ts';
import {
  applyResidentAnswer,
  finishResident,
  residentAssessment,
  residentQuestion,
} from '../src/resident-flow.ts';
import { writePrivate } from '../src/config.ts';
const { store, dataDir } = apiCheckContext();
const cases = [
  { name: 'healthy_only', text: '아니요, 몸이 불편하지 않습니다', expected: 'review' },
  { name: 'healthy_can_move', text: '몸은 괜찮고 혼자 걸어서 갈 수 있어요', expected: 'moving' },
  { name: 'no_transport', text: '몸은 괜찮지만 이동 수단이 없어서 못 가요', expected: 'rescue' },
  { name: 'cannot_walk', text: '다리가 불편해서 움직일 수 없어요', expected: 'rescue' },
  { name: 'refused', text: '집을 두고 떠날 수 없어요. 대피 안 할래요', expected: 'refused' },
  { name: 'direction_question', text: '어디로 가야 돼?', expected: 'review' },
];
const results = await Promise.all(
  cases.map(async (item) => {
    const a = residentAssessment();
    a.location = '집';
    a.stage = 'mobility';
    const began = Date.now();
    try {
      const answer = await classifyResident(store.value, item.text, a, residentQuestion(a));
      applyResidentAnswer(a, item.text, answer, residentQuestion(a));
      const result = finishResident(a);
      return {
        name: item.name,
        expected: item.expected,
        actual: result.kind,
        passed: result.kind === item.expected,
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
const report = {
  checkedAt: Date.now(),
  backendModel: store.value.BACKEND_MODEL,
  source: 'synthetic_text',
  telnyxUsed: false,
  results,
};
writePrivate(join(dataDir, 'resident-classification-check.json'), report);
console.log(JSON.stringify(report));
if (results.some((r) => !r.passed)) process.exitCode = 1;
