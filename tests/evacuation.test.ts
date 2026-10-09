import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyEvacuation } from '../src/evacuation.ts';
import { defaults } from '../src/config.ts';
test('현재 자기 신고를 strict JSON Schema·근거 원문·0.9 신뢰도로 검증', async () => {
  let count = 0,
    payload: any,
    result = {
      evacuated: true,
      location: '학교',
      evidence: '학교에 도착했어요',
      needsHelp: false,
      confidence: 0.99,
    };
  const fake: typeof fetch = async (_url, options) => {
    count++;
    payload = JSON.parse(String(options?.body));
    return Response.json({
      status: 'completed',
      output: [{ content: [{ type: 'output_text', text: JSON.stringify(result) }] }],
    });
  };
  const config = { ...defaults, OPENAI_API_KEY: 'sk-test', BACKEND_MODEL: 'configured-model' };
  for (const text of [
    '알겠어요',
    '네.',
    '아직 집이에요',
    '가는 중이에요',
    '학교에 갈 예정이에요',
    '집에 있고 대피소에 도착했어요',
    '대피소에 도착했지만 도움이 필요해요',
    '다른 사람이 도착했대요',
  ])
    assert.equal(await classifyEvacuation(config, text, [], fake), null, text);
  assert.equal(count, 0);
  assert.equal(
    (await classifyEvacuation(config, '학교에 도착했어요', [], fake))?.evidence,
    result.evidence,
  );
  assert.equal(payload.model, 'configured-model');
  assert.equal(payload.text.format.strict, true);
  assert.equal(payload.text.format.schema.additionalProperties, false);
  for (const patch of [
    { confidence: 0.89 },
    { evidence: '만들어진 문장' },
    { needsHelp: true },
    { evacuated: false },
  ]) {
    const original = { ...result };
    Object.assign(result, patch);
    assert.equal(await classifyEvacuation(config, '학교에 도착했어요', [], fake), null);
    result = original;
  }
  result = { ...result, evidence: '네.', location: '추정 학교' };
  assert.equal(
    (
      await classifyEvacuation(
        config,
        '네.',
        [{ speaker: 'assistant', text: '대피소에 도착하셨나요?' }],
        fake,
      )
    )?.location,
    '대피 장소 미상',
  );
});
test('분류 API 실패·불완전 응답·스키마 오류를 성공으로 처리하지 않음', async () => {
  for (const response of [
    Response.json({}, { status: 500 }),
    Response.json({ status: 'incomplete' }),
    Response.json({
      status: 'completed',
      output: [{ content: [{ type: 'output_text', text: '{"evacuated":true}' }] }],
    }),
  ])
    await assert.rejects(
      classifyEvacuation(defaults, '대피소에 도착했어요', [], async () => response),
    );
});
