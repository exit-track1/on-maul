import test from 'node:test';
import assert from 'node:assert/strict';
import { DATA } from '../src/data.ts';
import { DomainError, Runtime, type View } from '../src/runtime.ts';
import { dispatchSafety, evaluateDispatch, tripPosition } from '../src/dispatch.ts';
import {
  DEMO_DATASET,
  DEMO_JURISDICTION,
  predictionEvidence,
  sourceClocks,
  sourceMonitor,
  sourceReadings,
  validReplayCount,
} from '../src/monitoring.ts';
import { createSourceRecord, type SourceRecord } from '../src/sources.ts';

function windRecord(view: View): SourceRecord {
  return view.sourceState.records.findLast((record) => record.sourceId === 'SRC05')!;
}

function readyForTrip(): Runtime {
  const data = structuredClone(DATA);
  data.map.ignition = { x: 0, y: 0 };
  data.map.wind = { direction: 270, speedMps: 0 };
  const wind = data.sources.find((source) => source.id === 'SRC05')!;
  wind.demoPayload.windDirection = 270;
  wind.demoPayload.windSpeedMps = 0;
  wind.demoPayload.summary = '관할 무풍 합성 관측';
  for (const household of data.households) {
    household.demoPosition = { x: 900, y: 550 };
    household.mobility = '자력';
    household.devices = [];
    household.shelterId = 'S2';
  }
  const runtime = new Runtime(data);
  runtime.command('watch');
  runtime.command('plan');
  runtime.command('confirm', { revision: runtime.view().revision });
  const snapshot = runtime.view();
  // A synthetic response snapshot isolates source guards from call scheduling.
  for (const call of snapshot.calls) call.phase = 'finished';
  for (const status of snapshot.scenario.householdStatuses)
    status.status = data.households.find((household) => household.id === status.householdId)!
      .callEligible
      ? 'help'
      : 'visit';
  snapshot.memberResponses = Object.fromEntries(
    data.teams.flatMap((team) =>
      team.members.map((member) => [
        member.id,
        member.availability === '가능' ? ('ok' as const) : ('no' as const),
      ]),
    ),
  );
  runtime.restore(snapshot);
  runtime.command('comms', { down: false });
  return runtime;
}

function assertUnknownEta(view: View, householdId: string): void {
  assert.equal(predictionEvidence(view).usable, false);
  assert.equal(predictionEvidence(view).etaMustRemainUnknown, true);
  assert.equal(dispatchSafety(view, householdId).targetEta, null);
  assert.equal(dispatchSafety(view, householdId).zoneEta, null);
}

test('watch creates eight own-schema replay records and records zero actual model or telephone calls', () => {
  const runtime = new Runtime();
  assert.equal(runtime.view().sourceState.records.length, 0);
  const view = runtime.command('watch');
  assert.equal(view.sourceState.records.length, 8);
  assert.equal(new Set(view.sourceState.records.map((record) => record.recordId)).size, 8);
  assert.equal(new Set(view.sourceState.records.map((record) => record.sourceId)).size, 8);
  for (const record of view.sourceState.records) {
    const source = view.data.sources.find((source) => source.id === record.sourceId)!;
    assert.equal(record.mode, 'replay');
    assert.equal(record.origin, 'synthetic');
    assert.equal(record.scenarioId, view.scenario.id);
    assert.equal(record.datasetId, DEMO_DATASET);
    assert.equal(record.referenceDate, view.data.metadata.referenceDate);
    assert.equal(record.observedAt, source.demoPayload.observedAt);
    assert.equal(record.fetchedAt.replay, view.scenario.displayTime);
    assert.equal(record.fetchedAt.wall, view.sourceState.wallNow);
    assert.deepEqual(record.jurisdictions, [DEMO_JURISDICTION]);
    assert.deepEqual(view.sourceState.policies[record.sourceId]!.jurisdiction.areas, [
      DEMO_JURISDICTION,
    ]);
    assert.deepEqual(record.payload, source.demoPayload);
    assert.ok(record.sampleId);
    assert.ok(record.payloadHash);
  }
  const readings = sourceReadings(view);
  assert.equal(readings.length, 8);
  assert.ok(readings.every(({ status }) => status?.status === 'replay'));
  assert.ok(readings.every(({ status }) => status?.liveAttemptStatus === 'not-attempted'));
  assert.ok(readings.every(({ status }) => status?.actualLiveSucceeded === false));
  assert.equal(validReplayCount(view), 8);
  assert.ok(sourceMonitor(view).eligibleModelCallCount > 0);
  assert.equal(view.sourceState.actualModelCalls, 0);
  assert.equal(view.calls.length, 0);
});

test('repeated collect appends unique evidence while preserving the original observation and payload', () => {
  const runtime = new Runtime();
  const first = runtime.command('watch');
  runtime.command('collect');
  const third = runtime.command('collect');
  assert.equal(third.sourceState.records.length, 24);
  assert.equal(new Set(third.sourceState.records.map((record) => record.recordId)).size, 24);
  assert.deepEqual(third.sourceState.records.slice(0, 8), first.sourceState.records);
  for (const source of third.data.sources) {
    const own = third.sourceState.records.filter((record) => record.sourceId === source.id);
    assert.equal(own.length, 3);
    assert.ok(own.every((record) => record.observedAt === source.demoPayload.observedAt));
    assert.equal(new Set(own.map((record) => record.payloadHash)).size, 1);
    assert.ok(own.every((record) => record.mode === 'replay' && record.origin === 'synthetic'));
    assert.equal(own.at(-1)!.fetchedAt.replay, third.scenario.displayTime);
  }
  assert.equal(validReplayCount(third), 8);
  assert.equal(third.sourceState.actualModelCalls, 0);
  assert.equal(third.calls.length, 0);
});

test('live-failure demonstration and each replay fallback are separate records and never restore actual success', () => {
  const runtime = new Runtime();
  runtime.command('watch');
  const failedView = runtime.command('source-fail', { id: 'SRC01' });
  const failed = failedView.sourceState.records.at(-1)!;
  assert.equal(failed.mode, 'live');
  assert.equal(failed.origin, 'simulated-live-failure');
  assert.equal(failed.ok, false);
  assert.equal(failed.observedAt, null);
  assert.equal(failed.payload, null);
  assert.match(failed.error!, /실제 API 호출 없음/);
  assert.equal(failedView.sourceState.records.length, 9);
  runtime.command('collect');
  const view = runtime.command('collect');
  assert.equal(view.sourceState.records.length, 25);
  assert.deepEqual(
    view.sourceState.records.find((record) => record.recordId === failed.recordId),
    failed,
  );
  const fallbacks = view.sourceState.records.filter(
    (record) => record.fallbackForRecordId === failed.recordId,
  );
  assert.equal(fallbacks.length, 2);
  assert.ok(fallbacks.every((record) => record.mode === 'replay' && record.origin === 'synthetic'));
  assert.ok(fallbacks.every((record) => record.recordId !== failed.recordId));
  const status = sourceReadings(view).find(({ source }) => source.id === 'SRC01')!.status!;
  assert.equal(status.status, 'fail');
  assert.equal(status.liveAttemptStatus, 'failed');
  assert.equal(status.replayStatus, 'replayed');
  assert.equal(status.liveError, failed.error);
  assert.equal(status.actualLiveSucceeded, false);
  assert.deepEqual(status.failedLiveRecordIds, [failed.recordId]);
  assert.equal(validReplayCount(view), 7);
  assert.equal(
    view.scenario.sourceStatuses.find((source) => source.sourceId === 'SRC01')!.status,
    'fail',
  );
  assert.equal(view.sourceState.actualModelCalls, 0);
});

test('outside-jurisdiction records block every eligible model call and wind ETA in the restored runtime', () => {
  const runtime = new Runtime();
  const snapshot = runtime.command('scenario', { id: 'active' });
  for (const policy of Object.values(snapshot.sourceState.policies)) {
    policy.jurisdiction.id = 'DEMO-OTHER';
    policy.jurisdiction.revision = Number(policy.jurisdiction.revision) + 1;
    policy.jurisdiction.areas = ['DEMO-OTHER'];
  }
  runtime.restore(snapshot);
  const view = runtime.view();
  const monitor = sourceMonitor(view);
  assert.equal(monitor.eligibleModelCallCount, 0);
  assert.equal(monitor.eligibleRecords.length, 0);
  assert.ok(monitor.evaluations.every((result) => result.reasons.includes('outside-jurisdiction')));
  assert.equal(view.sourceState.actualModelCalls, 0);
  assertUnknownEta(view, 'H012');
  assert.ok(predictionEvidence(view).reasons.includes('SRC05:outside-jurisdiction'));
});

test('active wind remains fresh despite stale auxiliary feeds; late wind holds all new ETA and dispatch', () => {
  const runtime = new Runtime();
  const active = runtime.command('scenario', { id: 'active' });
  const activeWind = sourceReadings(active).find(({ source }) => source.id === 'SRC05')!.status!;
  assert.equal(activeWind.freshness.usable, true);
  assert.equal(activeWind.freshness.ageSeconds, 16 * 60);
  assert.equal(activeWind.freshness.maxAgeSeconds, 20 * 60);
  assert.equal(
    sourceReadings(active).find(({ source }) => source.id === 'SRC02')!.status!.freshness.state,
    'stale',
  );
  assert.equal(predictionEvidence(active).usable, true);
  assert.deepEqual(predictionEvidence(active).evidenceRecordIds, [windRecord(active).recordId]);
  assert.notEqual(dispatchSafety(active, 'H012').targetEta, null);
  assert.ok(active.plan!.order.every((item) => item.eta !== null));
  const late = runtime.command('scenario', { id: 'late' });
  const lateWind = sourceReadings(late).find(({ source }) => source.id === 'SRC05')!.status!;
  assert.equal(lateWind.freshness.state, 'stale');
  assert.equal(lateWind.freshness.ageSeconds, 35 * 60);
  assert.equal(lateWind.observedAt, activeWind.observedAt);
  assertUnknownEta(late, 'H012');
  assert.ok(late.plan!.order.every((item) => item.eta === null));
  assert.ok(late.plan!.visit.every((item) => item.eta === null));
  const target = late.scenario.householdStatuses.find(
    (status) =>
      late.data.households.find((household) => household.id === status.householdId)!.callEligible &&
      !['safe', 'rescued'].includes(status.status) &&
      !status.temporaryExclusion,
  )!.householdId;
  const check = evaluateDispatch(late, target, 'V04');
  assert.equal(check.ok, false);
  if (!check.ok) assert.equal(check.code, 'unknown_eta');
  assert.throws(
    () => runtime.command('dispatch', { id: target, vehicleId: 'V04' }),
    (error: unknown) => error instanceof DomainError && error.code === 'unknown_eta',
  );
  assert.equal(runtime.view().trips.length, 0);
});

test('wind failure holds an existing trip in place, keeps its reservation, and refuses new dispatch', () => {
  const runtime = readyForTrip();
  const dispatched = runtime.command('dispatch', { id: 'H041', vehicleId: 'V07' });
  const trip = dispatched.trips[0]!;
  assert.ok(trip);
  const position = tripPosition(trip, dispatched.simMinutes);
  const view = runtime.command('source-fail', { id: 'SRC05' });
  assertUnknownEta(view, 'H041');
  assert.equal(view.trips.length, 1);
  const held = view.trips[0]!;
  assert.equal(held.id, trip.id);
  assert.equal(held.vehicleId, trip.vehicleId);
  assert.equal(held.driverRef, trip.driverRef);
  assert.equal(held.teamId, trip.teamId);
  assert.deepEqual(held.crewMemberIds, trip.crewMemberIds);
  assert.equal(held.stage, trip.stage);
  assert.match(held.heldReason!, /ETA 불명/);
  assert.deepEqual(tripPosition(held, view.simMinutes), position);
  assert.equal(view.completedTrips.length, 0);
  assert.equal(
    view.scenario.resourceStatuses.find((resource) => resource.vehicleId === 'V07')!.status,
    'enroute',
  );
  assert.throws(() => runtime.command('dispatch', { id: 'H033', vehicleId: 'V06' }), /ETA 불명/);
  assert.throws(
    () => runtime.command('trip-resume', { id: held.id, revision: view.revision }),
    /ETA 불명/,
  );
  assert.equal(runtime.view().trips.length, 1);
  assert.equal(runtime.view().handoffs.length, 0);
  const collected = runtime.command('collect');
  const windStatus = sourceReadings(collected).find(({ source }) => source.id === 'SRC05')!.status!;
  assert.equal(windStatus.liveAttemptStatus, 'failed');
  assert.equal(windStatus.replayStatus, 'replayed');
  assert.equal(windStatus.actualLiveSucceeded, false);
  assert.equal(collected.trips[0]!.heldReason, held.heldReason);
  assert.deepEqual(tripPosition(collected.trips[0]!, collected.simMinutes), position);
});

test('historical, wrong dataset and different scenario wind records never enter the current ETA snapshot', () => {
  for (const mutation of ['historical', 'dataset', 'scenario', 'referenceDate'] as const) {
    const runtime = new Runtime();
    const snapshot = runtime.command('scenario', { id: 'active' });
    const wind = windRecord(snapshot);
    const replacement = createSourceRecord({
      ...wind,
      recordId: 'source-wind-' + mutation,
      ...(mutation === 'historical'
        ? {
            referenceDate: '2025-03-01',
            datasetId: 'historical-own-demo',
            scenarioId: 'historical-replay',
            origin: 'reconstructed' as const,
            observedAt: '2025-03-01T11:00:00+09:00',
            fetchedAt: { wall: snapshot.sourceState.wallNow, replay: '2025-03-01T11:02:00+09:00' },
          }
        : {}),
      ...(mutation === 'dataset' ? { datasetId: 'other-own-dataset' } : {}),
      ...(mutation === 'scenario' ? { scenarioId: 'late' } : {}),
      ...(mutation === 'referenceDate' ? { referenceDate: '2025-03-01' } : {}),
    });
    snapshot.sourceState.records.push(replacement);
    runtime.restore(snapshot);
    const view = runtime.view();
    assertUnknownEta(view, 'H012');
    assert.deepEqual(predictionEvidence(view).evidenceRecordIds, [replacement.recordId]);
    assert.ok(
      predictionEvidence(view).reasons.some((reason) => reason.includes('context-mismatch')),
    );
    assert.equal(
      sourceReadings(view).find(({ source }) => source.id === 'SRC05')!.status!.freshness.state,
      'unknown',
    );
    assert.equal(windRecord(view).observedAt, replacement.observedAt);
    assert.equal(view.sourceState.actualModelCalls, 0);
  }
});

test('current wall time does not age replay evidence; missing or future replay observations still hold ETA', () => {
  const runtime = new Runtime();
  const snapshot = runtime.command('scenario', { id: 'active' });
  snapshot.sourceState.wallNow = '2050-01-01T00:00:00Z';
  runtime.restore(snapshot);
  const view = runtime.view();
  assert.equal(predictionEvidence(view).usable, true);
  assert.equal(sourceClocks(view).wallNow, '2050-01-01T00:00:00Z');
  assert.equal(
    sourceReadings(view).find(({ source }) => source.id === 'SRC05')!.status!.freshness.ageSeconds,
    16 * 60,
  );
  for (const observedAt of [null, '2026-10-09T11:17:00+09:00']) {
    const invalid = structuredClone(snapshot);
    invalid.sourceState.records.push(
      createSourceRecord({
        ...windRecord(invalid),
        recordId: observedAt === null ? 'missing-observation' : 'future-observation',
        observedAt,
      }),
    );
    runtime.restore(invalid);
    assertUnknownEta(runtime.view(), 'H012');
  }
});

test('closed source export and JSON snapshot preserve evidence across reads, rejected writes and restart', () => {
  const runtime = new Runtime();
  runtime.command('watch');
  runtime.command('source-fail', { id: 'SRC01' });
  runtime.command('collect');
  const closed = runtime.command('close', { acknowledged: true });
  const serialized = JSON.stringify(closed);
  const evidenceBefore = sourceReadings(closed);
  assert.equal(closed.frozen, true);
  assert.equal(closed.scenario.mode, 'record');
  assert.equal(closed.sourceState.records.length, 17);
  assert.equal(closed.sourceState.actualModelCalls, 0);
  for (const action of ['collect', 'source-fail', 'advance'])
    assert.throws(
      () => runtime.command(action, { id: 'SRC05' }),
      (error: unknown) => error instanceof DomainError && error.code === 'frozen',
    );
  assert.equal(JSON.stringify(runtime.view()), serialized);
  assert.deepEqual(sourceReadings(runtime.view()), evidenceBefore);
  const exported = JSON.parse(serialized) as View;
  exported.sourceState.records[0]!.observedAt = '2099-01-01T00:00:00Z';
  exported.sourceState.policies.SRC01!.jurisdiction.areas = ['DEMO-OTHER'];
  assert.equal(JSON.stringify(runtime.view()), serialized);
  const restored = new Runtime();
  restored.restore(JSON.parse(serialized) as View);
  assert.deepEqual(restored.view(), JSON.parse(serialized) as View);
  assert.deepEqual(restored.view().sourceState, closed.sourceState);
  assert.deepEqual(sourceReadings(restored.view()), evidenceBefore);
  assert.equal(JSON.stringify(restored.view()), serialized);
  assert.equal(
    sourceReadings(restored.view()).find(({ source }) => source.id === 'SRC01')!.status!
      .liveAttemptStatus,
    'failed',
  );
  const memoryRestored = new Runtime();
  memoryRestored.restore(closed);
  assert.deepEqual(memoryRestored.view(), closed);
});

test('unrelated collection and auxiliary source failure preserve the reviewed manual order', () => {
  const runtime = new Runtime();
  runtime.command('watch');
  const proposal = runtime.command('plan');
  const reordered = runtime.command('reorder', {
    revision: proposal.revision,
    ids: proposal.plan!.order.map((item) => item.householdId).reverse(),
  });
  const collected = runtime.command('collect');
  assert.deepEqual(collected.plan, reordered.plan);
  assert.notEqual(collected.revision, reordered.revision);
  const failed = runtime.command('source-fail', { id: 'SRC01' });
  assert.deepEqual(failed.plan, reordered.plan);
  const fallback = runtime.command('collect');
  assert.deepEqual(fallback.plan, reordered.plan);
  assert.equal(fallback.calls.length, 0);
  assert.equal(fallback.sourceState.actualModelCalls, 0);
});

test('pending wind failure immediately recalculates ETA and rank; fallback requires reviewing the restored proposal', () => {
  const runtime = new Runtime();
  runtime.command('watch');
  const proposal = runtime.command('plan');
  assert.ok(proposal.plan!.order.some((item) => item.eta !== null));
  const failed = runtime.command('source-fail', { id: 'SRC05' });
  assert.equal(failed.plan!.confirmed, false);
  assert.equal(failed.plan!.revision, proposal.plan!.revision + 1);
  assert.equal(failed.plan!.snapshotRevision, failed.revision);
  assert.deepEqual(failed.plan!.order, runtime.planItems().order);
  assert.deepEqual(failed.plan!.visit, runtime.planItems().visit);
  assert.ok([...failed.plan!.order, ...failed.plan!.visit].every((item) => item.eta === null));
  assert.ok(failed.plan!.order.every((item) => /도달 불명/u.test(item.reason)));
  assert.ok(failed.records.some((record) => /미확정 계획 갱신.*재검토/u.test(record.label)));
  assert.equal(failed.calls.length, 0);
  assert.throws(
    () => runtime.command('confirm', { revision: proposal.revision }),
    (error: unknown) => error instanceof DomainError && error.code === 'stale_revision',
  );
  const collected = runtime.command('collect');
  assert.equal(collected.plan!.revision, failed.plan!.revision + 1);
  assert.equal(collected.plan!.snapshotRevision, collected.revision);
  assert.deepEqual(collected.plan!.order, proposal.plan!.order);
  assert.deepEqual(collected.plan!.visit, proposal.plan!.visit);
  assert.equal(collected.plan!.confirmed, false);
  assert.equal(collected.calls.length, 0);
  assert.throws(() => runtime.command('confirm', { revision: failed.revision }), /최신 화면/u);
  assert.equal(runtime.view().calls.length, 0);
  const confirmed = runtime.command('confirm', { revision: collected.revision });
  assert.equal(confirmed.plan!.confirmed, true);
  assert.ok(confirmed.calls.length > 0);
  assert.equal(confirmed.sourceState.actualModelCalls, 0);
});

test('restored pending plans revalidate stale and outside-jurisdiction evidence before any confirmation', () => {
  for (const change of ['stale', 'jurisdiction', 'historical'] as const) {
    const runtime = new Runtime();
    runtime.command('watch');
    const snapshot = runtime.command('plan');
    const originalPlanRevision = snapshot.plan!.revision;
    if (change === 'stale') snapshot.scenario.displayTime = '2026-10-09T11:35:00+09:00';
    if (change === 'jurisdiction')
      snapshot.sourceState.policies.SRC05!.jurisdiction = {
        id: 'DEMO-OTHER',
        revision: 2,
        areas: ['DEMO-OTHER'],
      };
    if (change === 'historical')
      snapshot.sourceState.records.push(
        createSourceRecord({
          ...windRecord(snapshot),
          recordId: 'historical-pending-plan',
          scenarioId: 'past-own-scenario',
          datasetId: 'past-own-dataset',
          referenceDate: '2025-03-01',
          origin: 'reconstructed',
          observedAt: '2025-03-01T11:00:00+09:00',
          fetchedAt: { wall: snapshot.sourceState.wallNow, replay: '2025-03-01T11:02:00+09:00' },
        }),
      );
    runtime.restore(snapshot);
    const view = runtime.view();
    assert.equal(view.plan!.revision, originalPlanRevision + 1, change);
    assert.equal(view.plan!.snapshotRevision, view.revision, change);
    assert.ok(
      [...view.plan!.order, ...view.plan!.visit].every((item) => item.eta === null),
      change,
    );
    assert.deepEqual(view.plan!.order, runtime.planItems().order, change);
    assert.equal(view.calls.length, 0, change);
    assert.equal(view.plan!.confirmed, false, change);
  }
});

test('changed observation evidence renews pending review while preserving an otherwise current manual order', () => {
  const runtime = new Runtime();
  runtime.command('watch');
  const proposal = runtime.command('plan');
  const snapshot = runtime.command('reorder', {
    revision: proposal.revision,
    ids: proposal.plan!.order.map((item) => item.householdId).reverse(),
  });
  snapshot.sourceState.records.push(
    createSourceRecord({
      ...windRecord(snapshot),
      recordId: 'changed-observation-same-wind',
      observedAt: '2026-10-09T10:59:00+09:00',
    }),
  );
  runtime.restore(snapshot);
  const view = runtime.view();
  assert.equal(predictionEvidence(view).usable, true);
  assert.equal(view.plan!.revision, snapshot.plan!.revision + 1);
  assert.notEqual(view.plan!.sourceSignature, snapshot.plan!.sourceSignature);
  assert.deepEqual(view.plan!.order, snapshot.plan!.order);
  assert.equal(view.calls.length, 0);
});

class DriftingRuntime extends Runtime {
  changeWithoutCommand(change: (view: View) => void) {
    change(this.state);
  }
}

test('confirmation compares every displayed condition and target group without mutating a rejected proposal', () => {
  const changes: ((view: View) => void)[] = [
    (view) => {
      view.plan!.order[0]!.eta = -1;
    },
    (view) => {
      view.plan!.order[0]!.score++;
    },
    (view) => {
      view.plan!.order[0]!.vulnerability++;
    },
    (view) => {
      view.plan!.order[0]!.reason = '오래된 근거';
    },
    (view) => {
      view.plan!.order[0]!.rank = 2;
    },
    (view) => {
      view.plan!.order[1]!.householdId = view.plan!.order[0]!.householdId;
    },
    (view) => {
      view.plan!.visit[0]!.reason = '오래된 방문 근거';
    },
    (view) => {
      view.plan!.excluded.push(view.plan!.order[0]!.householdId);
    },
    (view) => {
      view.sourceState.policies.SRC05!.jurisdiction.revision = 2;
    },
  ];
  for (const change of changes) {
    const runtime = new DriftingRuntime();
    runtime.command('watch');
    runtime.command('plan');
    runtime.changeWithoutCommand(change);
    const before = runtime.view();
    assert.throws(
      () => runtime.command('confirm', { revision: before.revision }),
      (error: unknown) =>
        error instanceof DomainError && error.code === 'plan_revalidation_required',
    );
    assert.deepEqual(runtime.view(), before);
    assert.equal(runtime.view().calls.length, 0);
  }
});

test('confirmation refuses new source failure arriving outside the command path; confirmed plans remain unchanged', () => {
  const runtime = new DriftingRuntime();
  runtime.command('watch');
  runtime.command('plan');
  runtime.changeWithoutCommand((view) => {
    view.sourceState.records.push(
      createSourceRecord({
        ...windRecord(view),
        recordId: 'callback-failed-wind',
        mode: 'live',
        origin: 'simulated-live-failure',
        sampleId: null,
        observedAt: null,
        fetchedAt: { wall: view.sourceState.wallNow, replay: null },
        payload: null,
        ok: false,
        error: '합성 수신 실패',
      }),
    );
  });
  const before = runtime.view();
  assert.throws(
    () => runtime.command('confirm', { revision: before.revision }),
    (error: unknown) => error instanceof DomainError && error.code === 'plan_revalidation_required',
  );
  assert.deepEqual(runtime.view(), before);
  const refreshed = runtime.command('collect');
  const confirmed = runtime.command('confirm', { revision: refreshed.revision });
  const confirmedPlan = structuredClone(confirmed.plan);
  runtime.command('source-fail', { id: 'SRC05' });
  assert.deepEqual(runtime.view().plan, confirmedPlan);
  assertUnknownEta(runtime.view(), 'H012');
  runtime.command('collect');
  assert.deepEqual(runtime.view().plan, confirmedPlan);
  assert.equal(runtime.view().sourceState.actualModelCalls, 0);
});
