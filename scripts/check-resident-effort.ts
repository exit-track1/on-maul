import { join } from 'node:path';
import { apiCheckContext } from './api-check-context.ts';
import { writePrivate } from '../src/config.ts';
import { classifyResident } from '../src/resident-classifier.ts';
import {
  applyResidentAnswer,
  finishResident,
  residentAssessment,
  residentQuestion,
} from '../src/resident-flow.ts';
const { store, dataDir } = apiCheckContext();
if (store.value.BACKEND_MODEL !== 'gpt-6.1-sol')
  throw new Error('이 비교는 BACKEND_MODEL=gpt-6.1-sol 설정에서 실행합니다.');
const cases = [
  {
    name: 'asr_vehicle_request',
    text: '어 나 지금 모둠지겨요. 차 보내주실 수 있나요',
    expected: 'rescue',
  },
  { name: 'healthy_only', text: '아니요 몸이 불편하지 않습니다', expected: 'review' },
  { name: 'healthy_can_move', text: '몸은 괜찮고 혼자 걸어서 갈 수 있어요', expected: 'moving' },
  { name: 'no_transport', text: '몸은 괜찮지만 이동 수단이 없어서 못 가요', expected: 'rescue' },
  { name: 'refused', text: '집을 두고 떠날 수 없어요. 대피 안 할래요', expected: 'refused' },
  { name: 'direction_question', text: '어디로 가야 돼?', expected: 'review' },
];
const results: {
  name: string;
  effort: string;
  expected: string;
  actual: string;
  passed: boolean;
  latencyMs: number;
  confidence?: number;
  outputTokens?: number;
  reasoningTokens?: number;
}[] = [];
for (const item of cases) {
  const pair = await Promise.all(
    (['low', 'high'] as const).map(async (effort) => {
      const assessment = residentAssessment();
      const question = residentQuestion(assessment);
      const began = Date.now();
      let outputTokens: number | undefined;
      let reasoningTokens: number | undefined;
      const fetcher: typeof fetch = async (url, options) => {
        const payload = JSON.parse(String(options?.body));
        payload.reasoning = { effort };
        // Give both efforts equal headroom; the production request stays low/1024/12s.
        payload.max_output_tokens = 8192;
        const response = await fetch(url, {
          ...options,
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(45000),
        });
        const data = (await response.clone().json()) as any;
        outputTokens = data.usage?.output_tokens;
        reasoningTokens = data.usage?.output_tokens_details?.reasoning_tokens;
        return response;
      };
      try {
        const answer = await classifyResident(
          store.value,
          item.text,
          assessment,
          question,
          fetcher,
        );
        applyResidentAnswer(assessment, item.text, answer, question);
        const actual = finishResident(assessment).kind;
        return {
          name: item.name,
          effort,
          expected: item.expected,
          actual,
          passed: actual === item.expected,
          latencyMs: Date.now() - began,
          confidence: answer.confidence,
          outputTokens,
          reasoningTokens,
        };
      } catch {
        return {
          name: item.name,
          effort,
          expected: item.expected,
          actual: 'api_unconfirmed',
          passed: false,
          latencyMs: Date.now() - began,
          outputTokens,
          reasoningTokens,
        };
      }
    }),
  );
  results.push(...pair);
  console.log(JSON.stringify({ case: item.name, results: pair }));
}
const summary = ['low', 'high'].map((effort) => {
  const rows = results.filter((row) => row.effort === effort);
  const latencies = rows.map((row) => row.latencyMs).sort((a, b) => a - b);
  return {
    effort,
    cases: rows.length,
    passed: rows.filter((row) => row.passed).length,
    medianMs: (latencies[2] + latencies[3]) / 2,
    minMs: latencies[0],
    maxMs: latencies.at(-1),
    outputTokens: rows.reduce((sum, row) => sum + (row.outputTokens ?? 0), 0),
    reasoningTokens: rows.reduce((sum, row) => sum + (row.reasoningTokens ?? 0), 0),
  };
});
const report = {
  checkedAt: Date.now(),
  model: store.value.BACKEND_MODEL,
  source: 'synthetic_text',
  samplesPerCase: 1,
  concurrentRequests: 2,
  maxOutputTokens: 8192,
  timeoutMs: 45000,
  telnyxUsed: false,
  productionEffortChanged: false,
  results,
  summary,
};
writePrivate(join(dataDir, 'resident-effort-comparison.json'), report);
console.log(JSON.stringify({ summary }));
if (results.some((row) => !row.passed)) process.exitCode = 1;
