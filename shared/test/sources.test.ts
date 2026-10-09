import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Source } from '../src/types.ts';
import {
  appendSourceAttempt,
  canonicalJson,
  createReplaySourceRecord,
  createSourceRecord,
  demoPayloadFingerprint,
  evaluateMonitoringRecord,
  evaluateSourceFreshness,
  planMonitoring,
  sourceModelCacheKey,
  sourceStatusFromRecords,
  validatePredictionSources,
  type MonitoringPolicy,
  type SourceClocks,
  type SourceRecordInput,
} from '../src/sources.ts';

const policy: MonitoringPolicy = {
  pollSeconds: 60,
  jurisdiction: { id: 'demo-village', revision: 1, areas: ['온빛 마을'] },
};
const clocks: SourceClocks = {
  wallNow: '2026-10-09T20:00:00+09:00',
  replay: {
    now: '2026-10-09T11:02:00+09:00',
    scenarioId: 'watch',
    datasetId: 'synthetic-20261009',
    referenceDate: '2026-10-09',
  },
};
function input(overrides: Partial<SourceRecordInput> = {}): SourceRecordInput {
  return {
    recordId: 'record-1',
    sourceId: 'SRC02',
    scenarioId: 'watch',
    datasetId: 'synthetic-20261009',
    referenceDate: '2026-10-09',
    mode: 'replay',
    origin: 'synthetic',
    sampleId: 'SRC02:demoPayload',
    observedAt: '2026-10-09T11:00:00+09:00',
    fetchedAt: { wall: '2026-10-09T19:00:00+09:00', replay: '2026-10-09T11:01:00+09:00' },
    jurisdictions: ['온빛 마을'],
    payload: { schema: 'onmaul-demo/v1', summary: '온빛 마을 산불 대피 시연' },
    ok: true,
    ...overrides,
  };
}
const record = (overrides: Partial<SourceRecordInput> = {}) => createSourceRecord(input(overrides));

test('fixture adapter preserves own schema and observed time while recording explicit collection provenance', () => {
  const sources = JSON.parse(
    readFileSync(new URL('../../fixtures/sources.json', import.meta.url), 'utf8'),
  ) as Source[];
  assert.equal(sources.length, 8);
  for (const source of sources) {
    const replay = createReplaySourceRecord(source, {
      recordId: 'fixture-' + source.id,
      scenarioId: 'watch',
      datasetId: 'synthetic-20261009',
      referenceDate: '2026-10-09',
      fetchedAtWall: clocks.wallNow,
      fetchedAtReplay: clocks.replay!.now,
      jurisdictions: ['온빛 마을'],
    });
    assert.equal(replay.mode, 'replay');
    assert.equal(replay.origin, 'synthetic');
    assert.equal(replay.observedAt, source.demoPayload.observedAt);
    assert.equal(replay.fetchedAt.wall, clocks.wallNow);
    assert.equal(replay.fetchedAt.replay, clocks.replay!.now);
    assert.deepEqual(replay.payload, source.demoPayload);
    assert.notEqual(replay.payload, source.demoPayload);
    assert.match(replay.payloadHash, /^fnv1a64:[a-f0-9]{16}$/);
    assert.equal(
      sourceStatusFromRecords(
        [replay],
        source.id,
        { pollSeconds: source.demoRefreshSeconds },
        clocks,
      )?.actualLiveSucceeded,
      false,
    );
  }
  assert.throws(
    () =>
      createReplaySourceRecord(
        { ...sources[0]!, synthetic: false },
        {
          recordId: 'unsupported',
          scenarioId: 'watch',
          datasetId: 'synthetic-20261009',
          referenceDate: '2026-10-09',
          fetchedAtWall: clocks.wallNow,
          fetchedAtReplay: clocks.replay!.now,
          jurisdictions: ['온빛 마을'],
        },
      ),
    /own synthetic demo schema/,
  );
});

test('outside-jurisdiction disaster text is filtered before any model counter increments', () => {
  const outside = record({ jurisdictions: ['다른 가상 마을'] });
  const plan = planMonitoring([outside], { SRC02: policy }, clocks);
  let modelCallCount = 0;
  for (const eligible of plan.eligibleRecords) {
    assert.ok(eligible);
    modelCallCount++;
  }
  assert.equal(modelCallCount, 0);
  assert.equal(plan.eligibleModelCallCount, 0);
  assert.equal(plan.evaluations[0]!.disasterMatched, true);
  assert.ok(plan.evaluations[0]!.reasons.includes('outside-jurisdiction'));
  assert.equal(plan.evaluations[0]!.cacheKey, null);
  assert.equal(
    evaluateMonitoringRecord(record({ jurisdictions: [] }), policy, clocks).eligibleForModel,
    false,
  );
  assert.equal(
    evaluateMonitoringRecord(
      record(),
      { ...policy, jurisdiction: { ...policy.jurisdiction, areas: [] } },
      clocks,
    ).eligibleForModel,
    false,
  );
  assert.equal(planMonitoring([record()], {}, clocks).eligibleModelCallCount, 0);
});

test('explicit jurisdiction tags match normalized exact areas, never text substrings', () => {
  assert.equal(
    evaluateMonitoringRecord(record({ jurisdictions: ['  온빛   마을  '] }), policy, clocks)
      .eligibleForModel,
    true,
  );
  assert.equal(
    evaluateMonitoringRecord(record({ jurisdictions: ['온빛 마을밖'] }), policy, clocks)
      .eligibleForModel,
    false,
  );
  assert.equal(
    evaluateMonitoringRecord(record({ jurisdictions: ['온빛'] }), policy, clocks).eligibleForModel,
    false,
  );
});

test('disaster keywords or independent documented threshold signals must pass the jurisdiction guard', () => {
  const quiet = { summary: '관할 시연 관측' };
  assert.equal(
    evaluateMonitoringRecord(record({ payload: quiet }), policy, clocks).eligibleForModel,
    false,
  );
  for (const signals of [
    { windSpeedMps: 10 },
    { extinguishmentDropPercentPoints: 10 },
    { waterLevel: 'attention' as const },
    { weatherAlert: 'warning' as const },
    { text: '모의 호우 통제' },
  ]) {
    const accepted = record({ payload: quiet, signals });
    assert.equal(evaluateMonitoringRecord(accepted, policy, clocks).eligibleForModel, true);
    assert.equal(
      evaluateMonitoringRecord(
        record({ payload: quiet, signals, jurisdictions: ['외부 마을'] }),
        policy,
        clocks,
      ).eligibleForModel,
      false,
    );
  }
  for (const signals of [
    { windSpeedMps: 9.99 },
    { extinguishmentDropPercentPoints: 9.99 },
    { waterLevel: 'normal' as const },
    { weatherAlert: 'watch' as const },
  ])
    assert.equal(
      evaluateMonitoringRecord(record({ payload: quiet, signals }), policy, clocks)
        .eligibleForModel,
      false,
    );
  assert.equal(
    evaluateMonitoringRecord(record(), { ...policy, thresholds: { windSpeedMps: NaN } }, clocks)
      .eligibleForModel,
    false,
  );
});

test('invalid normalized signals remain blocked even if the summary contains a disaster keyword', () => {
  for (const signals of [
    { windSpeedMps: NaN },
    { windSpeedMps: Infinity },
    { windSpeedMps: -1 },
    { extinguishmentDropPercentPoints: NaN },
    { waterLevel: 'unknown' },
    { weatherAlert: 'unknown' },
    { text: 1 },
  ]) {
    const evaluation = evaluateMonitoringRecord(
      record({ signals: signals as never }),
      policy,
      clocks,
    );
    assert.equal(evaluation.eligibleForModel, false);
    assert.ok(evaluation.reasons.includes('invalid-source-signals'));
    assert.equal(evaluation.cacheKey, null);
  }
});

test('freshness defaults to twice polling in seconds with an inclusive boundary', () => {
  const fresh = evaluateSourceFreshness(record(), policy, clocks);
  assert.equal(fresh.usable, true);
  assert.equal(fresh.ageSeconds, 120);
  assert.equal(fresh.maxAgeSeconds, 120);
  const stale = evaluateSourceFreshness(record(), policy, {
    ...clocks,
    replay: { ...clocks.replay!, now: '2026-10-09T11:02:00.001+09:00' },
  });
  assert.equal(stale.state, 'stale');
  assert.equal(stale.usable, false);
  assert.equal(stale.reason, 'stale-observation');
  assert.equal(
    evaluateSourceFreshness(
      record(),
      { ...policy, freshnessMaxAgeSeconds: 121 },
      { ...clocks, replay: { ...clocks.replay!, now: '2026-10-09T11:02:01+09:00' } },
    ).usable,
    true,
  );
  for (const invalidPolicy of [
    { pollSeconds: 0 },
    { pollSeconds: -1 },
    { pollSeconds: NaN },
    { pollSeconds: 60, freshnessMaxAgeSeconds: -1 },
  ])
    assert.equal(
      evaluateSourceFreshness(record(), invalidPolicy, clocks).reason,
      'invalid-freshness-policy',
    );
});

test('missing, invalid and future timestamps are unknown and cannot reach a model', () => {
  const cases: [Partial<SourceRecordInput>, string][] = [
    [{ observedAt: null }, 'missing-observed-time'],
    [{ observedAt: '' }, 'missing-observed-time'],
    [{ observedAt: '2026-02-30T11:00:00+09:00' }, 'invalid-observed-time'],
    [{ observedAt: '2026-10-09T24:00:00+09:00' }, 'invalid-observed-time'],
    [{ observedAt: '2026-10-09T11:00:00' }, 'invalid-observed-time'],
    [{ observedAt: '2026-10-09T11:00:00+14:01' }, 'invalid-observed-time'],
    [{ observedAt: '2026-10-09T11:03:00+09:00' }, 'future-observed-time'],
    [{ fetchedAt: { wall: clocks.wallNow, replay: null } }, 'missing-fetched-time'],
    [{ fetchedAt: { wall: clocks.wallNow, replay: 'bad time' } }, 'invalid-fetched-time'],
    [
      { fetchedAt: { wall: clocks.wallNow, replay: '2026-10-09T11:03:00+09:00' } },
      'future-fetched-time',
    ],
    [
      { fetchedAt: { wall: clocks.wallNow, replay: '2026-10-09T10:59:59+09:00' } },
      'observation-after-fetch',
    ],
    [{ payload: null }, 'missing-payload'],
  ];
  for (const [overrides, reason] of cases) {
    const evaluation = evaluateMonitoringRecord(record(overrides), policy, clocks);
    assert.equal(evaluation.freshness.reason, reason);
    assert.equal(evaluation.freshness.state, 'unknown');
    assert.equal(evaluation.freshness.stale, true);
    assert.equal(evaluation.eligibleForModel, false);
  }
  assert.equal(
    evaluateSourceFreshness(record(), policy, {
      ...clocks,
      replay: { ...clocks.replay!, now: 'invalid' },
    }).reason,
    'invalid-evaluation-clock',
  );
});

test('live uses wall time while historical replay uses only its explicitly matched scenario clock', () => {
  const historical = record({
    referenceDate: '2025-03-01',
    datasetId: 'historical-demo',
    scenarioId: 'historical-watch',
    observedAt: '2025-03-01T11:00:00+09:00',
    origin: 'reconstructed',
    fetchedAt: { wall: clocks.wallNow, replay: '2025-03-01T11:01:00+09:00' },
  });
  const isolated: SourceClocks = {
    wallNow: clocks.wallNow,
    replay: {
      now: '2025-03-01T11:02:00+09:00',
      referenceDate: '2025-03-01',
      datasetId: 'historical-demo',
      scenarioId: 'historical-watch',
    },
  };
  assert.equal(evaluateSourceFreshness(historical, policy, isolated).usable, true);
  assert.equal(
    evaluateSourceFreshness(historical, policy, { ...isolated, wallNow: 'bad unused wall clock' })
      .usable,
    true,
  );
  assert.equal(
    evaluateSourceFreshness(historical, policy, clocks).reason,
    'replay-clock-context-mismatch',
  );
  assert.equal(
    evaluateSourceFreshness(historical, policy, { wallNow: clocks.wallNow }).reason,
    'missing-replay-clock',
  );
  for (const change of [
    { scenarioId: 'another' },
    { datasetId: 'another' },
    { referenceDate: '2025-03-02' },
  ])
    assert.equal(
      evaluateSourceFreshness(historical, policy, {
        ...isolated,
        replay: { ...isolated.replay!, ...change },
      }).usable,
      false,
    );
  const oldLive = record({
    mode: 'live',
    origin: 'live-response',
    scenarioId: null,
    observedAt: '2025-03-01T11:00:00+09:00',
    fetchedAt: { wall: clocks.wallNow, replay: isolated.replay!.now },
  });
  assert.equal(evaluateSourceFreshness(oldLive, policy, isolated).state, 'stale');
  const currentLive = record({
    mode: 'live',
    origin: 'live-response',
    scenarioId: null,
    observedAt: clocks.wallNow,
    fetchedAt: { wall: clocks.wallNow, replay: null },
  });
  assert.equal(
    evaluateSourceFreshness(currentLive, policy, { wallNow: clocks.wallNow }).usable,
    true,
  );
});

test('source5 stays fresh at active 11:16 and becomes stale at late 11:35 without fabricated observations', () => {
  const source = (
    JSON.parse(
      readFileSync(new URL('../../fixtures/sources.json', import.meta.url), 'utf8'),
    ) as Source[]
  ).find((item) => item.id === 'SRC05')!;
  for (const [scenarioId, now, usable] of [
    ['active', '2026-10-09T11:16:00+09:00', true],
    ['late', '2026-10-09T11:35:00+09:00', false],
  ] as const) {
    const sample = createReplaySourceRecord(source, {
      recordId: scenarioId,
      scenarioId,
      datasetId: clocks.replay!.datasetId,
      referenceDate: clocks.replay!.referenceDate,
      fetchedAtWall: clocks.wallNow,
      fetchedAtReplay: now,
      jurisdictions: ['온빛 마을'],
    });
    const sampleClocks = { ...clocks, replay: { ...clocks.replay!, now, scenarioId } };
    assert.equal(
      evaluateSourceFreshness(sample, { pollSeconds: source.demoRefreshSeconds }, sampleClocks)
        .usable,
      usable,
    );
    assert.equal(sample.observedAt, '2026-10-09T11:00:00+09:00');
  }
});

test('canonical payload fingerprints are stable for object order and reject unsupported JSON', () => {
  assert.equal(canonicalJson({ b: [2, 1], a: '한글' }), canonicalJson({ a: '한글', b: [2, 1] }));
  assert.equal(demoPayloadFingerprint(''), 'fnv1a64:cbf29ce484222325');
  assert.equal(demoPayloadFingerprint('a'), 'fnv1a64:af63dc4c8601ec8c');
  assert.notEqual(
    record({ payload: { a: 1 } }).payloadHash,
    record({ payload: { a: 2 } }).payloadHash,
  );
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  for (const invalid of [NaN, Infinity, { a: undefined }, new Date(), cyclic, [, 1]])
    assert.throws(() => canonicalJson(invalid as never));
});

test('cache keys isolate jurisdiction changes, payloads, source, sample, scenario, dataset, mode and provenance', () => {
  const original = record();
  const key = sourceModelCacheKey(original, policy);
  for (const changedPolicy of [
    { ...policy, jurisdiction: { ...policy.jurisdiction, id: 'other' } },
    { ...policy, jurisdiction: { ...policy.jurisdiction, revision: 2 } },
    { ...policy, jurisdiction: { ...policy.jurisdiction, areas: ['다른 마을'] } },
    { ...policy, disasterKeywords: ['홍수'] },
    { ...policy, thresholds: { windSpeedMps: 12 } },
    { ...policy, freshnessMaxAgeSeconds: 180 },
  ])
    assert.notEqual(sourceModelCacheKey(original, changedPolicy), key);
  for (const overrides of [
    { sourceId: 'SRC05' },
    { sampleId: 'sample-other' },
    { scenarioId: 'active' },
    { datasetId: 'other-dataset' },
    { referenceDate: '2026-10-10' },
    { origin: 'reconstructed' as const },
    { payload: { summary: '변경 산불' } },
    { jurisdictions: ['다른 마을'] },
    { signals: { windSpeedMps: 11 } },
    { mode: 'live' as const, origin: 'live-response' as const, scenarioId: null },
  ])
    assert.notEqual(sourceModelCacheKey(record(overrides), policy), key);
  assert.equal(sourceModelCacheKey(record({ recordId: 'second-collection' }), policy), key);
  assert.equal(
    sourceModelCacheKey(original, {
      ...policy,
      jurisdiction: { ...policy.jurisdiction, areas: [' 온빛  마을 ', '온빛 마을'] },
    }),
    key,
  );
});

test('full canonical inputs prevent cache aliasing even if supplied payload hashes collide', () => {
  const hash = () => 'test:deliberate-collision';
  const first = createSourceRecord(input({ payload: { summary: '산불 첫 자료' } }), hash);
  const second = createSourceRecord(input({ payload: { summary: '산불 다른 자료' } }), hash);
  assert.equal(first.payloadHash, second.payloadHash);
  assert.notEqual(sourceModelCacheKey(first, policy), sourceModelCacheKey(second, policy));
});

test('failed live attempt and fallback replay remain separate immutable evidence records', () => {
  const failed = record({
    recordId: 'live-failed',
    mode: 'live',
    origin: 'simulated-live-failure',
    scenarioId: null,
    datasetId: 'simulated-live-attempt',
    ok: false,
    payload: null,
    observedAt: null,
    error: '모의 수신 타임아웃',
    fetchedAt: { wall: clocks.wallNow, replay: null },
  });
  const before = appendSourceAttempt([], failed);
  const fallback = record({ recordId: 'replay-fallback', fallbackForRecordId: failed.recordId });
  const after = appendSourceAttempt(before, fallback);
  assert.equal(before.length, 1);
  assert.equal(after.length, 2);
  assert.equal(after[0], failed);
  assert.equal(after[0]!.ok, false);
  assert.equal(after[0]!.error, '모의 수신 타임아웃');
  assert.equal(after[1]!.mode, 'replay');
  assert.equal(after[1]!.origin, 'synthetic');
  const view = sourceStatusFromRecords(after, 'SRC02', policy, clocks)!;
  assert.equal(view.status, 'fail');
  assert.equal(view.liveAttemptStatus, 'failed');
  assert.equal(view.replayStatus, 'replayed');
  assert.equal(view.actualLiveSucceeded, false);
  assert.equal(view.liveError, '모의 수신 타임아웃');
  assert.deepEqual(view.failedLiveRecordIds, ['live-failed']);
  assert.equal(view.recordId, 'replay-fallback');
  assert.equal(view.liveRecordId, 'live-failed');
  assert.equal(view.replayRecordId, 'replay-fallback');
  assert.equal(view.observedAt, fallback.observedAt);
  assert.throws(() => appendSourceAttempt(after, fallback), /Duplicate/);
  assert.throws(() => appendSourceAttempt([], fallback), /preserved failed live attempt/);
  assert.throws(
    () =>
      appendSourceAttempt(
        before,
        record({
          recordId: 'wrong-source',
          sourceId: 'SRC05',
          fallbackForRecordId: failed.recordId,
        }),
      ),
    /same source/,
  );
});

test('synthetic replay can never create or report successful actual live collection', () => {
  assert.throws(
    () => record({ mode: 'live', origin: 'synthetic' }),
    /cannot claim a successful live response/,
  );
  assert.throws(
    () => record({ mode: 'live', origin: 'reconstructed' }),
    /cannot claim a successful live response/,
  );
  assert.throws(() => record({ mode: 'replay', origin: 'live-response' }), /replay provenance/);
  const replay = record({ origin: 'recorded-live' });
  const projection = sourceStatusFromRecords([replay], 'SRC02', policy, clocks)!;
  assert.equal(projection.status, 'replay');
  assert.equal(projection.liveAttemptStatus, 'not-attempted');
  assert.equal(projection.actualLiveSucceeded, false);
});

test('prediction inputs prohibit historical/current or scenario/dataset/date mixtures and hold unknown ETA', () => {
  const expected = {
    mode: 'replay' as const,
    scenarioId: 'watch',
    datasetId: 'synthetic-20261009',
    referenceDate: '2026-10-09',
    requiredSourceIds: ['SRC02'],
  };
  const original = record();
  assert.equal(
    validatePredictionSources([original], { SRC02: policy }, clocks, expected).usable,
    true,
  );
  for (const overrides of [
    { mode: 'live' as const, origin: 'live-response' as const, observedAt: clocks.wallNow },
    { scenarioId: 'active' },
    { datasetId: 'other' },
    { referenceDate: '2025-03-01' },
    { observedAt: null },
  ]) {
    const result = validatePredictionSources(
      [record(overrides)],
      { SRC02: policy },
      clocks,
      expected,
    );
    assert.equal(result.usable, false);
    assert.equal(result.etaMustRemainUnknown, true);
    assert.deepEqual(result.evidenceRecordIds, ['record-1']);
  }
  const stale = { ...clocks, replay: { ...clocks.replay!, now: '2026-10-09T11:03:00+09:00' } };
  assert.equal(
    validatePredictionSources([original], { SRC02: policy }, stale, expected).etaMustRemainUnknown,
    true,
  );
  assert.equal(
    validatePredictionSources([], { SRC02: policy }, clocks, expected).etaMustRemainUnknown,
    true,
  );
  assert.equal(
    validatePredictionSources([original], {}, clocks, expected).etaMustRemainUnknown,
    true,
  );
  assert.ok(
    validatePredictionSources([original], { SRC02: policy }, clocks, {
      ...expected,
      requiredSourceIds: ['SRC05'],
    }).reasons.includes('SRC05:missing-required-source'),
  );
  assert.ok(
    validatePredictionSources(
      [original, record({ recordId: 'duplicate-source' })],
      { SRC02: policy },
      clocks,
      expected,
    ).reasons.includes('duplicate-source:duplicate-source'),
  );
});

test('record identity, reference date and replay sample context are required, and the input payload is not mutated', () => {
  for (const overrides of [
    { recordId: '' },
    { sourceId: '' },
    { datasetId: '' },
    { referenceDate: '2026-02-30' },
    { scenarioId: null },
    { sampleId: null },
  ])
    assert.throws(() => record(overrides));
  const payload = { summary: '산불 시연', nested: { value: 1 } };
  const sample = record({ payload });
  payload.nested.value = 2;
  assert.deepEqual(sample.payload, { summary: '산불 시연', nested: { value: 1 } });
  assert.ok(Object.isFrozen(sample));
  assert.ok(Object.isFrozen(sample.payload));
  assert.equal(sourceStatusFromRecords([], 'SRC02', policy, clocks), null);
});
