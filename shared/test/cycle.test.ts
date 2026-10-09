import test from 'node:test';
import assert from 'node:assert/strict';
import { DATA } from '../src/data.ts';
import { DomainError, Runtime, type View } from '../src/runtime.ts';
import { cycleBudget, initialSimulation } from '../src/cycle.ts';
import { predictionEvidence, sourceReadings } from '../src/monitoring.ts';
import { tripPosition } from '../src/dispatch.ts';

function start(runtime = new Runtime()) {
  const review = runtime.command('cycle-start', { revision: runtime.view().revision });
  return { runtime, review };
}
function run(runtime = new Runtime()) {
  const { review } = start(runtime);
  return { runtime, confirmed: runtime.command('confirm', { revision: review.revision }) };
}
function status(view: View, id: string) {
  return view.scenario.householdStatuses.find((status) => status.householdId === id)!;
}

test('cycle begins with 48 original households, a pending human review, explicit synthetic observations and zero calls', () => {
  const runtime = new Runtime();
  assert.deepEqual(runtime.view().simulation, initialSimulation());
  const { review } = start(runtime);
  assert.equal(review.simulation.phase, 'review');
  assert.equal(review.simulation.playing, false);
  assert.equal(review.simulation.speed, 30);
  assert.equal(review.simulation.durationMinutes, 40);
  assert.equal(review.simMinutes, 0);
  assert.equal(review.scenario.mode, 'event');
  assert.equal(review.plan!.confirmed, false);
  assert.equal(review.plan!.snapshotRevision, review.revision);
  assert.equal(review.calls.length, 0);
  assert.equal(review.data.households.length, 48);
  assert.equal(review.scenario.counts.total, 48);
  assert.equal(predictionEvidence(review).usable, true);
  assert.ok(
    review.sourceState.records.every(
      (record) =>
        record.mode === 'replay' &&
        record.origin === 'synthetic' &&
        record.sampleId!.includes('합성 cycle 관측'),
    ),
  );
  assert.deepEqual(runtime.tickCycle(40), review);
  const speed = runtime.command('sim', { revision: review.revision, speed: 60 });
  assert.equal(speed.simulation.phase, 'review');
  assert.equal(speed.simulation.playing, false);
  assert.throws(
    () => runtime.command('sim', { revision: speed.revision, playing: true }),
    /발령 확정/u,
  );
  const manual = runtime.command('reorder', {
    revision: speed.revision,
    ids: speed.plan!.order.map((item) => item.householdId).reverse(),
  });
  assert.equal(manual.simulation.phase, 'review');
  assert.equal(manual.calls.length, 0);
  assert.throws(() => runtime.command('confirm', { revision: review.revision }), /최신 화면/u);
  const confirmed = runtime.command('confirm', { revision: manual.revision });
  assert.equal(confirmed.simulation.phase, 'running');
  assert.equal(confirmed.simulation.playing, true);
  assert.equal(confirmed.simulation.speed, 60);
  assert.equal(confirmed.calls.filter((call) => call.phase === 'calling').length, 8);
});

test('fractional clock-only pulses preserve revision; event boundaries finish calls and keep the shared eight-channel limit', () => {
  const { runtime, confirmed } = run();
  const fraction = runtime.tickCycle(0.1);
  assert.equal(fraction.simMinutes, 0.1);
  assert.equal(fraction.revision, confirmed.revision);
  assert.ok(fraction.calls.every((call) => call.finishedSim === undefined));
  const boundary = runtime.tickCycle(0.9);
  assert.equal(boundary.simMinutes, 1);
  assert.ok(boundary.revision > fraction.revision);
  assert.equal(boundary.calls.filter((call) => call.finishedSim === 1).length, 8);
  assert.ok(
    boundary.calls.filter((call) => ['calling', 'pendingunknown'].includes(call.phase)).length <= 8,
  );
  assert.ok(
    boundary.calls.some((call) => call.targetType === 'member' && call.phase === 'finished'),
  );
  for (let pulse = 0; pulse < 100; pulse++) {
    const view = runtime.tickCycle(0.1);
    assert.ok(
      view.calls.filter((call) => ['calling', 'pendingunknown'].includes(call.phase)).length <= 8,
    );
  }
});

test('pause and outage discard elapsed time; restoring communication requires explicit replay and uses latest revision', () => {
  const { runtime } = run();
  const advanced = runtime.tickCycle(0.5);
  const paused = runtime.command('sim', { revision: advanced.revision, playing: false, speed: 12 });
  assert.deepEqual(runtime.tickCycle(500), paused);
  assert.throws(
    () => runtime.command('sim', { revision: paused.revision - 1, playing: true }),
    /최신 화면/u,
  );
  const resumed = runtime.command('sim', { revision: paused.revision, playing: true });
  const down = runtime.command('comms', { down: true });
  assert.equal(down.simulation.playing, false);
  assert.deepEqual(runtime.tickCycle(100), down);
  assert.throws(
    () => runtime.command('sim', { revision: down.revision, playing: true }),
    /통신 복구/u,
  );
  const connected = runtime.command('comms', { down: false });
  assert.equal(connected.simulation.playing, false);
  assert.deepEqual(runtime.tickCycle(100), connected);
  runtime.command('sim', { revision: connected.revision, playing: true });
  const progressed = runtime.tickCycle(0.5);
  assert.equal(progressed.simMinutes, resumed.simMinutes + 0.5);
  assert.equal(progressed.simulation.speed, 12);
});

test('many fast pulses and one accumulated tick consume the same appointments without duplicate calls or dropped fractions', () => {
  const { runtime: pulse } = run();
  const { runtime: bulk } = run();
  for (let i = 0; i < 400; i++) pulse.tickCycle(0.1);
  const first = pulse.view(),
    second = bulk.tickCycle(40);
  assert.equal(first.simMinutes, second.simMinutes);
  assert.deepEqual(first.calls, second.calls);
  assert.deepEqual(first.scenario.counts, second.scenario.counts);
  assert.equal(new Set(first.calls.map((call) => call.id)).size, first.calls.length);
  assert.deepEqual(first.firstPass, second.firstPass);
  assert.deepEqual(first.simulation, second.simulation);
  let elapsed = 0,
    remainder = 0;
  for (let i = 0; i < 300; i++) {
    const budget = cycleBudget(elapsed, 1 / 300, remainder);
    elapsed = budget.target;
    remainder = budget.remainder;
  }
  assert.ok(Math.abs(elapsed + remainder / 1_000_000 - 1) < 1e-10);
});

test('purpose-specific fictional follow-ups provide current shelter arrival evidence and preserve unresolved handover', () => {
  const { runtime } = run();
  const end = runtime.tickCycle(40);
  assert.equal(end.simulation.phase, 'awaiting_handover');
  assert.equal(end.simulation.playing, false);
  assert.ok(end.simMinutes <= 40);
  assert.ok(end.firstPass && end.firstPass.completedAtSim <= 10);
  assert.ok(
    end.calls.some((call) => call.purpose === 'clarification' && call.phase === 'finished'),
  );
  const arrivals = end.calls.filter(
    (call) => call.purpose === 'arrival_check' && call.outcome === 'answered',
  );
  assert.ok(arrivals.length > 0);
  assert.ok(arrivals.every((call) => /합성 cycle 허구 발화.*도착했어요/u.test(call.text)));
  assert.ok(
    arrivals.every((call) => ['safe', 'rescued'].includes(status(end, call.targetId).status)),
  );
  assert.ok(
    end.scenario.counts.safe > 0 && end.scenario.counts.safe < end.scenario.counts.eligible,
  );
  assert.equal(status(end, 'H007').status, 'noanswer');
  assert.equal(end.calls.filter((call) => call.targetId === 'H007').length, 9);
  assert.equal(end.scenario.counts.visit, 3);
  assert.ok(
    end.scenario.householdStatuses
      .filter(
        (item) =>
          !end.data.households.find((household) => household.id === item.householdId)!.callEligible,
      )
      .every((item) => !item.visitCompleted),
  );
  assert.ok(
    end.records.some((record) => record.label.startsWith('합성 cycle 이장 허구 연락 완료')),
  );
  assert.ok(end.leaderRequested.length > 0);
  assert.ok(end.reassignments.every((proposal) => proposal.status === 'pending'));
  assert.equal(end.sourceState.actualModelCalls, 0);
});

test('generated cycle observations stay fresh through later playback while failed attempts and fallback links remain separate', () => {
  const { runtime } = run();
  runtime.tickCycle(20);
  const failed = runtime.command('source-fail', { id: 'SRC05' });
  const failedRecord = failed.sourceState.records.at(-1)!;
  assert.equal(failedRecord.ok, false);
  const continued = runtime.tickCycle(1);
  assert.equal(predictionEvidence(continued).usable, true);
  const wind = continued.sourceState.records.findLast((record) => record.sourceId === 'SRC05')!;
  assert.equal(wind.fallbackForRecordId, failedRecord.recordId);
  assert.equal(wind.observedAt, continued.scenario.displayTime);
  assert.match(wind.sampleId!, /합성 cycle 관측/u);
  assert.equal(wind.origin, 'synthetic');
  assert.deepEqual(
    continued.sourceState.records.find((record) => record.recordId === failedRecord.recordId),
    failedRecord,
  );
  assert.equal(
    sourceReadings(continued).find(({ source }) => source.id === 'SRC05')!.status!
      .actualLiveSucceeded,
    false,
  );
  assert.equal(
    sourceReadings(continued).find(({ source }) => source.id === 'SRC05')!.status!
      .liveAttemptStatus,
    'failed',
  );
  assert.deepEqual(continued.data.sources, DATA.sources);
  assert.equal(continued.sourceState.actualModelCalls, 0);
});

class CycleRuntime extends Runtime {
  mutate(change: (view: View) => void) {
    change(this.state);
  }
}

test('cycle clock never completes actual calls and a new cycle refuses active or unknown real sessions', () => {
  const runtime = new CycleRuntime();
  run(runtime);
  runtime.mutate((view) => {
    view.calls.push({
      id: 'actual-wall-clock-session',
      targetId: 'H012',
      targetType: 'resident',
      attempt: 1,
      phase: 'pendingunknown',
      providerId: 'synthetic-port-session-id',
      nextAt: null,
      text: '',
      mode: 'telnyx',
      startedSim: 0,
    });
  });
  const original = runtime.view().calls.at(-1)!;
  const revision = runtime.view().revision;
  assert.throws(
    () => runtime.command('cycle-start', { revision }),
    (error: unknown) => error instanceof DomainError && error.code === 'live_session',
  );
  const continued = runtime.tickCycle(3);
  assert.deepEqual(
    continued.calls.find((call) => call.id === original.id),
    original,
  );
  assert.ok(
    continued.calls.filter((call) => ['calling', 'pendingunknown'].includes(call.phase)).length <=
      8,
  );
});

test('automatic candidates use atomic reservations and route guards, and ambulance busy never substitutes a general vehicle', () => {
  const runtime = new CycleRuntime();
  run(runtime);
  runtime.mutate((view) => {
    for (const household of view.data.households) {
      household.demoPosition = { x: 900, y: 550 };
      household.mobility = '자력';
      household.devices = [];
      household.shelterId = 'S2';
    }
    view.data.map.ignition = { x: 0, y: 0 };
    view.data.map.wind = { direction: 270, speedMps: 0 };
    view.memberResponses = Object.fromEntries(
      view.data.teams.flatMap((team) =>
        team.members.map((member) => [member.id, member.availability === '가능' ? 'ok' : 'no']),
      ),
    );
    status(view, 'H012').status = 'e119';
    const ambulance = view.scenario.resourceStatuses.find(
      (resource) => resource.vehicleId === 'V01',
    )!;
    ambulance.status = 'busy';
    status(view, 'H041').status = 'help';
  });
  const moving = runtime.tickCycle(0.1);
  assert.ok(!moving.trips.some((trip) => trip.householdId === 'H012'));
  assert.equal(status(moving, 'H012').status, 'e119');
  assert.match(status(moving, 'H012').dispatchHold!, /예약|출동|복귀/u);
  assert.ok(moving.trips.some((trip) => trip.householdId === 'H041'));
  assert.equal(new Set(moving.trips.map((trip) => trip.vehicleId)).size, moving.trips.length);
  assert.equal(new Set(moving.trips.map((trip) => trip.driverRef)).size, moving.trips.length);
  const trip = moving.trips.find((trip) => trip.householdId === 'H041')!;
  const position = tripPosition(trip, moving.simMinutes);
  const blocked = runtime.command('source-fail', { id: 'SRC05' });
  const held = blocked.trips.find((item) => item.id === trip.id)!;
  assert.match(held.heldReason!, /ETA 불명/u);
  assert.deepEqual(tripPosition(held, blocked.simMinutes), position);
  runtime.tickCycle(1);
  assert.equal(
    runtime.view().trips.find((item) => item.id === trip.id)!.heldReason,
    held.heldReason,
  );
});

test('handover requires explicit close; closed reports and restart stay frozen and a fresh cycle resets all synthetic work', () => {
  const { runtime } = run();
  const end = runtime.tickCycle(40);
  assert.throws(() => runtime.command('close'), /인수인계/u);
  assert.throws(
    () => runtime.command('sim', { revision: end.revision, playing: true }),
    /검토·진행/u,
  );
  const closed = runtime.command('close', { acknowledged: true });
  assert.equal(closed.simulation.phase, 'ended');
  assert.equal(closed.frozen, true);
  const serialized = JSON.stringify(closed);
  assert.equal(JSON.stringify(runtime.tickCycle(40)), serialized);
  const restored = new Runtime();
  restored.restore(JSON.parse(serialized) as View);
  assert.equal(JSON.stringify(restored.view()), serialized);
  assert.equal(JSON.stringify(restored.tickCycle(40)), serialized);
  const newCycle = restored.command('cycle-start', { revision: closed.revision });
  assert.notEqual(newCycle.simulation.cycleId, closed.simulation.cycleId);
  assert.equal(newCycle.simulation.phase, 'review');
  assert.equal(newCycle.frozen, false);
  assert.equal(newCycle.simMinutes, 0);
  assert.equal(newCycle.calls.length, 0);
  assert.equal(newCycle.trips.length, 0);
  assert.equal(newCycle.completedTrips.length, 0);
  assert.deepEqual(
    newCycle.data.households.find((household) => household.id === 'H001'),
    DATA.households.find((household) => household.id === 'H001'),
  );
  assert.equal(
    newCycle.data.households.find((household) => household.id === 'H012')!.name,
    '반영환 할아버지',
  );
});

test('grandfather story moves a confirmed ambulance through pickup, boarding and the actual shelter admission', () => {
  const { runtime, review } = start();
  assert.equal(review.demonstration!.story, 'grandfather');
  assert.equal(review.demonstration!.residentId, 'H012');
  const confirmed = runtime.command('confirm', { revision: review.revision });
  assert.equal(confirmed.demonstration!.stage, 'dialing');
  const talking = runtime.tickCycle(0.25);
  assert.equal(talking.demonstration!.stage, 'talking');
  assert.ok(talking.demonstration!.messages.some((message) => message.speaker === 'assistant'));
  const requested = runtime.tickCycle(0.75);
  const trip = requested.trips.find((trip) => trip.householdId === 'H012')!;
  assert.ok(trip);
  assert.equal(trip.vehicleId, 'V01');
  assert.equal(trip.driverRef, 'M02');
  assert.equal(requested.memberResponses.M02, 'ok');
  assert.equal(requested.demonstration!.stage, 'responding');
  assert.equal(requested.calls.find((call) => call.targetId === 'H012')!.phase, 'finished');
  assert.ok(
    requested.demonstration!.messages.some(
      (message) => message.speaker === 'resident' && /다리가 아파/u.test(message.text),
    ),
  );
  assert.ok(
    requested.demonstration!.messages.some((message) => /검증된 구급차를 보내/u.test(message.text)),
  );
  assert.throws(() => runtime.command('trip', { id: trip.id, stage: 'shelter' }), /다음 단계/u);
  assert.ok(
    !runtime.view().shelterAdmissions.some((admission) => admission.householdId === 'H012'),
  );
  const pickup = runtime.tickCycle(
    Math.ceil(trip.arriveSim * 1_000_000) / 1_000_000 - requested.simMinutes,
  );
  assert.equal(pickup.demonstration!.stage, 'boarding');
  const boarded = runtime.tickCycle(
    Math.ceil(trip.boardSim * 1_000_000) / 1_000_000 - pickup.simMinutes,
  );
  assert.equal(boarded.demonstration!.stage, 'evacuating');
  assert.ok(!boarded.shelterAdmissions.some((admission) => admission.householdId === 'H012'));
  const arrival = runtime.tickCycle(
    Math.ceil(trip.shelterSim * 1_000_000) / 1_000_000 - boarded.simMinutes,
  );
  assert.equal(arrival.demonstration!.stage, 'completed');
  assert.equal(status(arrival, 'H012').status, 'rescued');
  assert.ok(
    arrival.shelterAdmissions.some(
      (admission) => admission.householdId === 'H012' && admission.tripId === trip.id,
    ),
  );
  assert.ok(arrival.trips.some((item) => item.id === trip.id && item.stage === 'shelter'));
  assert.ok(
    arrival.demonstration!.messages.every((message) =>
      /합성 시연 텍스트·실모델\/음성통화 아님/u.test(message.text),
    ),
  );
  assert.equal(arrival.sourceState.actualModelCalls, 0);
});

test('squad story waits for the named member and two-person crew, protects the primary candidate, then completes via shelter evidence', () => {
  const runtime = new Runtime();
  const review = runtime.command('cycle-start', {
    revision: runtime.view().revision,
    demoStory: 'squad',
  });
  assert.equal(review.demonstration!.residentId, 'H009');
  assert.equal(
    review.data.teams
      .find((team) => team.id === 'TW')!
      .members.find((member) => member.id === 'M01')!.name,
    '반영환 대원',
  );
  runtime.command('confirm', { revision: review.revision });
  const waiting = runtime.tickCycle(5);
  assert.equal(waiting.demonstration!.stage, 'requested');
  assert.ok(!waiting.trips.some((trip) => trip.householdId === 'H009'));
  assert.equal(waiting.calls.find((call) => call.targetId === 'M01')!.phase, 'calling');
  assert.equal(waiting.calls.find((call) => call.targetId === 'M01')!.startedSim, 5);
  assert.equal(waiting.memberResponses.M01, 'waiting');
  assert.ok(
    !waiting.trips.some((trip) =>
      trip.crewMemberIds.some((id) => ['M01', 'M02', 'M03'].includes(id)),
    ),
  );
  const response = runtime.tickCycle(1);
  const trip = response.trips.find((trip) => trip.householdId === 'H009')!;
  assert.ok(trip);
  assert.equal(trip.vehicleId, 'V04');
  assert.equal(trip.teamId, 'TW');
  assert.equal(trip.departSim, 6);
  assert.ok(trip.crewMemberIds.length >= 2);
  assert.ok(trip.crewMemberIds.every((id) => response.memberResponses[id] === 'ok'));
  assert.equal(response.demonstration!.stage, 'responding');
  assert.ok(
    response.demonstration!.messages.some(
      (message) => message.speaker === 'member' && /가능합니다/u.test(message.text),
    ),
  );
  const arrival = runtime.tickCycle(
    Math.ceil(trip.shelterSim * 1_000_000) / 1_000_000 - response.simMinutes,
  );
  assert.equal(arrival.demonstration!.stage, 'completed');
  assert.equal(status(arrival, 'H009').status, 'rescued');
  assert.ok(
    arrival.shelterAdmissions.some(
      (admission) => admission.householdId === 'H009' && admission.tripId === trip.id,
    ),
  );
});

test('busy story resources and unknown real member sessions never create substituted trips or fake completion', () => {
  for (const story of ['grandfather', 'squad'] as const) {
    const runtime = new CycleRuntime();
    const review = runtime.command('cycle-start', {
      revision: runtime.view().revision,
      demoStory: story,
    });
    runtime.mutate((view) => {
      view.scenario.resourceStatuses.find(
        (resource) => resource.vehicleId === view.demonstration!.vehicleId,
      )!.status = 'busy';
    });
    runtime.command('confirm', { revision: review.revision });
    const end = runtime.tickCycle(40);
    assert.notEqual(end.demonstration!.stage, 'completed');
    assert.ok(
      ![...end.trips, ...end.completedTrips].some(
        (trip) => trip.householdId === end.demonstration!.residentId,
      ),
    );
    assert.ok(
      !end.shelterAdmissions.some(
        (admission) => admission.householdId === end.demonstration!.residentId,
      ),
    );
  }
  const runtime = new CycleRuntime();
  const review = runtime.command('cycle-start', {
    revision: runtime.view().revision,
    demoStory: 'squad',
  });
  runtime.command('confirm', { revision: review.revision });
  runtime.mutate((view) => {
    view.calls = view.calls.filter((call) => call.targetId !== 'M01');
    view.calls.push({
      id: 'real-unknown-member',
      targetId: 'M01',
      targetType: 'member',
      mode: 'telnyx',
      phase: 'pendingunknown',
      attempt: 1,
      nextAt: null,
      providerId: 'synthetic-port-only',
      text: '',
    });
  });
  const original = runtime.view().calls.find((call) => call.id === 'real-unknown-member')!;
  const end = runtime.tickCycle(40);
  assert.deepEqual(
    end.calls.find((call) => call.id === original.id),
    original,
  );
  assert.equal(end.memberResponses.M01, 'waiting');
  assert.notEqual(end.demonstration!.stage, 'completed');
  assert.ok(!end.shelterAdmissions.some((admission) => admission.householdId === 'H009'));
});

test('cycle refusal connects a plainly synthetic leader after one minute and waits for arrival evidence; legacy refusal stays human controlled', () => {
  const { runtime } = run();
  let view = runtime.view();
  while (
    !view.records.some(
      (record) =>
        record.householdId === 'H011' && record.label.startsWith('합성 cycle 이장 연결 시작'),
    )
  )
    view = runtime.tickCycle(1);
  const startAt = view.simMinutes;
  assert.equal(status(view, 'H011').status, 'visiting');
  view = runtime.tickCycle(0.5);
  assert.equal(status(view, 'H011').status, 'visiting');
  view = runtime.tickCycle(0.5);
  assert.equal(view.simMinutes, startAt + 1);
  assert.equal(status(view, 'H011').status, 'moving');
  assert.equal(status(view, 'H011').callbackAtSim, view.simMinutes + 15);
  assert.ok(
    view.records.some(
      (record) => record.householdId === 'H011' && /실제 이장 연락 없음/u.test(record.label),
    ),
  );
  view = runtime.tickCycle(20);
  assert.equal(status(view, 'H011').status, 'safe');
  const legacy = new Runtime();
  legacy.command('watch');
  const plan = legacy.command('plan');
  legacy.command('confirm', { revision: plan.revision });
  for (let i = 0; i < 8; i++) legacy.command('advance');
  assert.equal(status(legacy.view(), 'H011').status, 'refuse');
  assert.ok(!legacy.view().leaderRequested.includes('H011'));
});

test('a partially connected synthetic leader restores its due time from the saved event and stays paused until explicitly resumed', () => {
  const { runtime } = run();
  let view = runtime.view();
  while (
    !view.records.some(
      (record) =>
        record.householdId === 'H011' && record.label.startsWith('합성 cycle 이장 연결 시작'),
    )
  )
    view = runtime.tickCycle(1);
  view = runtime.tickCycle(0.5);
  const due = view.simMinutes + 0.5;
  const restored = new Runtime();
  restored.restore(JSON.parse(JSON.stringify(view)) as View);
  assert.equal(restored.view().simulation.playing, false);
  assert.equal(restored.view().networkDown, true);
  assert.deepEqual(restored.view().demonstration, view.demonstration);
  restored.command('comms', { down: false });
  const paused = restored.view();
  assert.deepEqual(restored.tickCycle(20), paused);
  restored.command('sim', { revision: paused.revision, playing: true });
  const completed = restored.tickCycle(0.5);
  assert.equal(completed.simMinutes, due);
  assert.equal(status(completed, 'H011').status, 'moving');
  assert.equal(status(completed, 'H011').callbackAtSim, due + 15);
  assert.equal(
    completed.records.filter(
      (record) =>
        record.householdId === 'H011' && record.label.startsWith('합성 cycle 이장 허구 연락 완료'),
    ).length,
    1,
  );
});

test('restoration preserves human leader cancellations after a synthetic connection, including identical event timestamps', () => {
  for (const result of ['방문 필요', '연락 불가']) {
    for (const delay of [0, 0.5]) {
      const runtime = new Runtime();
      const review = runtime.command('cycle-start', {
        revision: runtime.view().revision,
        demoStory: 'squad',
      });
      let view = runtime.command('confirm', { revision: review.revision });
      while (
        !view.records.some(
          (record) =>
            record.householdId === 'H011' && record.label.startsWith('합성 cycle 이장 연결 시작'),
        )
      )
        view = runtime.tickCycle(1);
      if (delay) runtime.tickCycle(delay);
      const cancelled = runtime.command('leader-result', { id: 'H011', result });
      const connectionIndex = cancelled.records.findLastIndex(
        (record) =>
          record.householdId === 'H011' && record.label.startsWith('합성 cycle 이장 연결 시작'),
      );
      const resultIndex = cancelled.records.findLastIndex(
        (record) =>
          record.householdId === 'H011' &&
          record.actorType === 'human' &&
          record.label.startsWith('이장 결과·'),
      );
      assert.ok(resultIndex > connectionIndex);
      if (delay === 0)
        assert.equal(
          cancelled.records[resultIndex]!.timestamp,
          cancelled.records[connectionIndex]!.timestamp,
        );
      assert.equal(status(cancelled, 'H011').status, 'visiting');
      assert.equal(status(cancelled, 'H011').note, result);
      const uninterrupted = runtime.tickCycle(1);
      const restored = new Runtime();
      restored.restore(JSON.parse(JSON.stringify(cancelled)) as View);
      const connected = restored.command('comms', { down: false });
      restored.command('sim', { revision: connected.revision, playing: true });
      const resumed = restored.tickCycle(1);
      assert.deepEqual(status(resumed, 'H011'), status(uninterrupted, 'H011'));
      assert.equal(status(resumed, 'H011').status, 'visiting');
      assert.equal(status(resumed, 'H011').note, result);
      assert.equal(status(resumed, 'H011').callbackAtSim, null);
      assert.ok(
        !resumed.records.some(
          (record) =>
            record.householdId === 'H011' &&
            record.label.startsWith('합성 cycle 이장 허구 연락 완료'),
        ),
      );
    }
  }
});

test('the last human leader result wins journal order even if a saved pending note survives at the same timestamp', () => {
  const { runtime } = run();
  let view = runtime.view();
  while (
    !view.records.some(
      (record) =>
        record.householdId === 'H011' && record.label.startsWith('합성 cycle 이장 연결 시작'),
    )
  )
    view = runtime.tickCycle(1);
  const pendingNote = status(view, 'H011').note;
  const cancelled = runtime.command('leader-result', { id: 'H011', result: '연락 불가' });
  // Exercise conservative journal recovery with a stale materialized note and newer human evidence.
  status(cancelled, 'H011').note = pendingNote;
  const restored = new Runtime();
  restored.restore(JSON.parse(JSON.stringify(cancelled)) as View);
  const connected = restored.command('comms', { down: false });
  restored.command('sim', { revision: connected.revision, playing: true });
  const resumed = restored.tickCycle(1);
  assert.equal(status(resumed, 'H011').status, 'visiting');
  assert.equal(status(resumed, 'H011').callbackAtSim, null);
  assert.ok(
    !resumed.records.some(
      (record) =>
        record.householdId === 'H011' && record.label.startsWith('합성 cycle 이장 허구 연락 완료'),
    ),
  );
});
