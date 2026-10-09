import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.ts';
import { config, type TelnyxPort } from '../src/telephony.ts';
import type { View } from '../../shared/src/runtime.ts';
import { createSourceRecord } from '../../shared/src/sources.ts';
import { predictionEvidence, sourceReadings } from '../../shared/src/monitoring.ts';
import { tripPosition } from '../../shared/src/dispatch.ts';

type Session = Awaited<ReturnType<typeof createApp>>;
async function fixture(t: TestContext) {
  const journal = mkdtempSync(join(tmpdir(), 'onmaul-source-api-'));
  const sessions = new Set<Session>();
  let transportCalls = 0;
  const port: TelnyxPort = {
    async dial() {
      transportCalls++;
      throw new Error('Source tests must not use a telephone transport.');
    },
    async hangup() {
      transportCalls++;
      throw new Error('Source tests must not use a telephone transport.');
    },
  };
  const settings = config({ ON_EXECUTION_MODE: 'demo', TELNYX_API_KEY: 'disabled-test-key' });
  t.after(async () => {
    try {
      const results = await Promise.allSettled([...sessions].map(({ app }) => app.close()));
      for (const result of results) if (result.status === 'rejected') throw result.reason;
    } finally {
      rmSync(journal, { recursive: true, force: true });
    }
  });
  let current = await createApp({ settings, port, journal });
  sessions.add(current);
  return {
    journal,
    current: () => current,
    transportCalls: () => transportCalls,
    post: (action: string, input: Record<string, unknown> = {}) =>
      current.app.inject({ method: 'POST', url: '/api/command', payload: { action, input } }),
    export: () => current.app.inject('/api/export.json'),
    async restart() {
      await current.app.close();
      sessions.delete(current);
      current = await createApp({ settings, port, journal });
      sessions.add(current);
      return current;
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function command(
  f: Fixture,
  action: string,
  input: Record<string, unknown> = {},
): Promise<View> {
  const response = await f.post(action, input);
  assert.equal(response.statusCode, 200, response.body);
  return response.json<View>();
}
async function assertNoExternalCalls(f: Fixture): Promise<void> {
  const response = await f.current().app.inject('/api/health');
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().executionMode, 'demo');
  assert.equal(response.json().inference, 'rules');
  assert.equal(response.json().externalInferenceCalls, 0);
  assert.equal(f.current().runtime.view().sourceState.actualModelCalls, 0);
  assert.equal(f.transportCalls(), 0);
}

async function prepareTrip(f: Fixture): Promise<View> {
  await command(f, 'watch');
  const proposal = await command(f, 'plan');
  const snapshot = await command(f, 'confirm', { revision: proposal.revision });
  // Restore a wholly synthetic response snapshot so this test exercises source/HTTP persistence,
  // independently of the call scheduler and emergency ETA branch.
  snapshot.data.map.ignition = { x: 0, y: 0 };
  snapshot.data.map.wind = { direction: 270, speedMps: 0 };
  const wind = snapshot.data.sources.find((source) => source.id === 'SRC05')!;
  wind.demoPayload.windDirection = 270;
  wind.demoPayload.windSpeedMps = 0;
  wind.demoPayload.summary = '합성 무풍 관측';
  for (const household of snapshot.data.households) {
    household.demoPosition = { x: 900, y: 550 };
    household.mobility = '자력';
    household.devices = [];
    household.shelterId = 'S2';
  }
  for (const call of snapshot.calls) {
    call.phase = 'finished';
    call.outcome = 'answered';
  }
  for (const status of snapshot.scenario.householdStatuses)
    status.status = snapshot.data.households.find(
      (household) => household.id === status.householdId,
    )!.callEligible
      ? 'help'
      : 'visit';
  snapshot.memberResponses = Object.fromEntries(
    snapshot.data.teams.flatMap((team) =>
      team.members.map((member) => [
        member.id,
        member.availability === '가능' ? ('ok' as const) : ('no' as const),
      ]),
    ),
  );
  f.current().runtime.restore(snapshot);
  await command(f, 'comms', { down: false });
  // Collect the edited own-schema sample so its payload and the demo wind input agree.
  await command(f, 'collect');
  return command(f, 'dispatch', { id: 'H041', vehicleId: 'V07' });
}

test('HTTP failure and replay fallbacks export the same evidence IDs, errors and provenance as the journal', async (t) => {
  const f = await fixture(t);
  const watching = await command(f, 'watch');
  const failedView = await command(f, 'source-fail', { id: 'SRC01' });
  const failed = failedView.sourceState.records.at(-1)!;
  await command(f, 'collect');
  const collected = await command(f, 'collect');
  const exported = await f.export();
  assert.equal(exported.statusCode, 200);
  assert.match(
    String(exported.headers['content-disposition']),
    /attachment.*onmaul-mock-report\.json/,
  );
  const report = exported.json<View>();
  const saved = JSON.parse(readFileSync(join(f.journal, 'snapshot.json'), 'utf8')) as View;
  assert.deepEqual(report.sourceState, collected.sourceState);
  assert.deepEqual(saved.sourceState, report.sourceState);
  assert.equal(report.sourceState.records.length, 25);
  assert.deepEqual(
    report.sourceState.records.find((record) => record.recordId === failed.recordId),
    failed,
  );
  assert.equal(failed.mode, 'live');
  assert.equal(failed.origin, 'simulated-live-failure');
  assert.equal(failed.ok, false);
  assert.match(failed.error!, /실제 API 호출 없음/);
  const original = watching.sourceState.records.find((record) => record.sourceId === 'SRC01')!;
  const fallbacks = report.sourceState.records.filter(
    (record) => record.fallbackForRecordId === failed.recordId,
  );
  assert.equal(fallbacks.length, 2);
  for (const fallback of fallbacks) {
    assert.notEqual(fallback.recordId, failed.recordId);
    assert.equal(fallback.mode, 'replay');
    assert.equal(fallback.origin, 'synthetic');
    assert.equal(fallback.observedAt, original.observedAt);
    assert.equal(fallback.payloadHash, original.payloadHash);
  }
  const reading = sourceReadings(report).find(({ source }) => source.id === 'SRC01')!.status!;
  assert.equal(reading.liveRecordId, failed.recordId);
  assert.equal(reading.replayRecordId, fallbacks.at(-1)!.recordId);
  assert.equal(reading.liveError, failed.error);
  assert.equal(reading.liveAttemptStatus, 'failed');
  assert.equal(reading.replayStatus, 'replayed');
  assert.equal(reading.actualLiveSucceeded, false);
  assert.equal(report.calls.length, 0);
  await assertNoExternalCalls(f);
});

test('HTTP wind failure preserves a held reservation and its evidence through fallback export and journal restart', async (t) => {
  const f = await fixture(t);
  const dispatched = await prepareTrip(f);
  const trip = dispatched.trips[0]!;
  const position = tripPosition(trip, dispatched.simMinutes);
  const failed = await command(f, 'source-fail', { id: 'SRC05' });
  const failedRecord = failed.sourceState.records.at(-1)!;
  assert.equal(predictionEvidence(failed).etaMustRemainUnknown, true);
  const rejected = await f.post('dispatch', { id: 'H033', vehicleId: 'V06' });
  assert.equal(rejected.statusCode, 409);
  assert.equal(rejected.json().code, 'unknown_eta');
  const held = failed.trips[0]!;
  assert.equal(held.id, trip.id);
  assert.match(held.heldReason!, /ETA 불명/);
  assert.deepEqual(tripPosition(held, failed.simMinutes), position);
  const collected = await command(f, 'collect');
  const report = (await f.export()).json<View>();
  assert.equal(report.trips.length, 1);
  assert.deepEqual(report.trips[0], collected.trips[0]);
  assert.equal(report.trips[0]!.heldReason, held.heldReason);
  assert.equal(report.trips[0]!.vehicleId, trip.vehicleId);
  assert.equal(report.trips[0]!.driverRef, trip.driverRef);
  assert.deepEqual(report.trips[0]!.crewMemberIds, trip.crewMemberIds);
  assert.equal(
    report.scenario.resourceStatuses.find((resource) => resource.vehicleId === trip.vehicleId)!
      .status,
    'enroute',
  );
  const fallback = report.sourceState.records.findLast((record) => record.sourceId === 'SRC05')!;
  assert.equal(fallback.fallbackForRecordId, failedRecord.recordId);
  assert.equal(
    sourceReadings(report).find(({ source }) => source.id === 'SRC05')!.status!.liveError,
    failedRecord.error,
  );
  const sourceEvidence = structuredClone(report.sourceState);
  await f.restart();
  const restoredResponse = await f.current().app.inject('/api/state');
  assert.equal(restoredResponse.statusCode, 200);
  const restored = restoredResponse.json<View>();
  assert.equal(restored.networkDown, true);
  assert.deepEqual(restored.sourceState, sourceEvidence);
  assert.deepEqual(restored.trips, report.trips);
  assert.deepEqual(tripPosition(restored.trips[0]!, restored.simMinutes), position);
  await command(f, 'comms', { down: false });
  assert.deepEqual((await f.export()).json<View>().trips, report.trips);
  await assertNoExternalCalls(f);
});

test('HTTP stale and historical wind reject dispatch with unknown_eta and preserve the failing context in export', async (t) => {
  const f = await fixture(t);
  const late = await command(f, 'scenario', { id: 'late' });
  const target = late.scenario.householdStatuses.find(
    (status) =>
      late.data.households.find((household) => household.id === status.householdId)!.callEligible &&
      !['safe', 'rescued'].includes(status.status) &&
      !status.temporaryExclusion,
  )!.householdId;
  const snapshotBeforeReject = readFileSync(join(f.journal, 'snapshot.json'), 'utf8');
  const staleRejected = await f.post('dispatch', { id: target, vehicleId: 'V04' });
  assert.equal(staleRejected.statusCode, 409);
  assert.equal(staleRejected.json().code, 'unknown_eta');
  assert.equal(readFileSync(join(f.journal, 'snapshot.json'), 'utf8'), snapshotBeforeReject);
  const staleExport = (await f.export()).json<View>();
  assert.ok(staleExport.plan!.order.every((item) => item.eta === null));
  assert.equal(
    sourceReadings(staleExport).find(({ source }) => source.id === 'SRC05')!.status!.freshness
      .reason,
    'stale-observation',
  );
  const active = await command(f, 'scenario', { id: 'active' });
  const currentWind = active.sourceState.records.findLast((record) => record.sourceId === 'SRC05')!;
  const historic = createSourceRecord({
    ...currentWind,
    recordId: 'SOURCE-HISTORICAL-OWN-2025',
    origin: 'reconstructed',
    scenarioId: 'historical-own-replay',
    datasetId: 'historical-own-2025',
    referenceDate: '2025-03-01',
    observedAt: '2025-03-01T11:00:00+09:00',
    fetchedAt: { wall: active.sourceState.wallNow, replay: '2025-03-01T11:02:00+09:00' },
    payload: {
      schema: 'onmaul-demo/v1',
      summary: '과거 합성 바람 재생',
      observedAt: '2025-03-01T11:00:00+09:00',
      windDirection: 280,
      windSpeedMps: 9,
      value: null,
    },
  });
  active.sourceState.records.push(historic);
  f.current().runtime.restore(active);
  await command(f, 'comms', { down: false });
  const historicTarget = active.scenario.householdStatuses.find(
    (status) =>
      active.data.households.find((household) => household.id === status.householdId)!
        .callEligible &&
      !['safe', 'rescued'].includes(status.status) &&
      !status.temporaryExclusion,
  )!.householdId;
  const historicRejected = await f.post('dispatch', { id: historicTarget, vehicleId: 'V04' });
  assert.equal(historicRejected.statusCode, 409);
  assert.equal(historicRejected.json().code, 'unknown_eta');
  const report = (await f.export()).json<View>();
  const evidence = predictionEvidence(report);
  assert.equal(evidence.etaMustRemainUnknown, true);
  assert.deepEqual(evidence.evidenceRecordIds, [historic.recordId]);
  assert.ok(evidence.reasons.some((reason) => reason.includes('context-mismatch')));
  assert.deepEqual(report.sourceState.records.at(-1), historic);
  assert.equal(report.trips.length, 0);
  await f.restart();
  const restored = (await f.export()).json<View>();
  assert.deepEqual(restored.sourceState.records.at(-1), historic);
  assert.equal(predictionEvidence(restored).etaMustRemainUnknown, true);
  await assertNoExternalCalls(f);
});

test('closed HTTP source export is byte-stable after failed writes and restoration from the journal', async (t) => {
  const f = await fixture(t);
  await command(f, 'watch');
  await command(f, 'source-fail', { id: 'SRC02' });
  await command(f, 'collect');
  await command(f, 'close', { acknowledged: true });
  const first = await f.export();
  assert.equal(first.statusCode, 200);
  const saved = readFileSync(join(f.journal, 'snapshot.json'), 'utf8');
  const report = first.json<View>();
  assert.equal(report.frozen, true);
  assert.deepEqual(JSON.parse(saved), report);
  for (const action of ['source-fail', 'collect']) {
    const rejected = await f.post(action, { id: 'SRC05' });
    assert.equal(rejected.statusCode, 409);
    assert.equal(rejected.json().code, 'frozen');
  }
  assert.equal(readFileSync(join(f.journal, 'snapshot.json'), 'utf8'), saved);
  assert.equal((await f.export()).body, first.body);
  await f.restart();
  assert.equal((await f.export()).body, first.body);
  const restored = (await f.current().app.inject('/api/state')).json<View>();
  assert.deepEqual(restored.sourceState, report.sourceState);
  const status = sourceReadings(restored).find(({ source }) => source.id === 'SRC02')!.status!;
  assert.equal(status.liveAttemptStatus, 'failed');
  assert.equal(status.replayStatus, 'replayed');
  assert.equal(status.actualLiveSucceeded, false);
  assert.ok(status.failedLiveRecordIds.includes(status.liveRecordId!));
  await assertNoExternalCalls(f);
});
