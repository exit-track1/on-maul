import { join } from 'node:path';
import { apiCheckContext } from './api-check-context.ts';
import { classifyResident } from '../src/resident-classifier.ts';
import {
  applyResidentAnswer,
  finishResident,
  residentAssessment,
  residentQuestion,
  residentQuestions,
} from '../src/resident-flow.ts';
import { writePrivate } from '../src/config.ts';
const { store, dataDir } = apiCheckContext();
const cases = [
  { name: 'healthy_only', text: '아니요, 몸이 불편하지 않습니다', expected: 'review' },
  { name: 'healthy_can_move', text: '몸은 괜찮고 혼자 걸어서 갈 수 있어요', expected: 'moving' },
  { name: 'no_transport', text: '몸은 괜찮지만 이동 수단이 없어서 못 가요', expected: 'rescue' },
  { name: 'cannot_walk', text: '다리가 불편해서 움직일 수 없어요', expected: 'rescue' },
  {
    name: 'legs_cannot_move',
    text: '집에 있는데요, 다리가 너무 움직이지 않아요',
    expected: 'rescue',
  },
  { name: 'legs_correction', text: '다리가 너무 움직이지 않는다니까요', expected: 'rescue' },
  {
    name: 'vehicle_request',
    text: '어 나 지금 못 움직여요. 차 보내주실 수 있나요',
    expected: 'rescue',
  },
  {
    name: 'asr_vehicle_request',
    text: '어 나 지금 모둠지겨요. 차 보내주실 수 있나요',
    expected: 'rescue',
  },
  { name: 'support_yes', text: '네', question: residentQuestions.assistance, expected: 'rescue' },
  {
    name: 'support_no',
    text: '아니요',
    question: residentQuestions.assistance,
    expected: 'review',
  },
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
      const question = item.question ?? residentQuestion(a);
      const answer = await classifyResident(store.value, item.text, a, question);
      applyResidentAnswer(a, item.text, answer, question);
      const result = finishResident(a);
      return {
        name: item.name,
        expected: item.expected,
        actual: result.kind,
        passed: result.kind === item.expected,
        mobility: answer.mobility,
        confidence: answer.confidence,
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
