import test from 'node:test';
import assert from 'node:assert/strict';
import { Runtime, type View, type PhoneRuntimeOutcome } from '../src/runtime.ts';
import type { DemoStory } from '../src/demo-story.ts';

function start(story: DemoStory = 'grandfather') {
  const runtime = new Runtime();
  const review = runtime.command('cycle-start', {
    revision: runtime.view().revision,
    demoStory: story,
    phoneMode: 'live',
  });
  const confirmed = runtime.command('confirm', { revision: review.revision });
  return { runtime, confirmed, residentId: confirmed.demonstration!.residentId };
}
function status(view: View, id: string) {
  return view.scenario.householdStatuses.find((value) => value.householdId === id)!;
}
function request(runtime: Runtime, targetId: string, id = `phone-${targetId}`) {
  runtime.preparePhoneCall(targetId, id);
  runtime.applyPhoneUpdate(id, { phase: 'talking', providerId: `provider-${targetId}` });
  return id;
}
function residentOutcome(
  runtime: Runtime,
  requestId: string,
  mobility: PhoneRuntimeOutcome['mobility'] = 'needs_help',
) {
  return runtime.applyPhoneOutcome(requestId, {
    ended: true,
    kind: 'resident',
    mobility,
    evidence:
      mobility === 'needs_help' ? '다리가 아파 움직일 수 없어요. 차를 보내주세요.' : '수신자 응답',
  });
}

for (const story of ['grandfather', 'squad'] as const) {
  test(`${story} live playback plans only its actual target and creates zero mock calls`, () => {
    const { runtime, confirmed, residentId } = start(story);
    assert.equal(confirmed.demonstration!.phoneMode, 'live');
    assert.equal(confirmed.demonstration!.phoneClockHeld, false);
    assert.equal(confirmed.demonstration!.stage, story === 'squad' ? 'requested' : 'ready');
    assert.deepEqual(runtime.pendingPhoneTargets(), [story === 'squad' ? 'M01' : residentId]);
    assert.equal(confirmed.calls.length, 0);
    assert.deepEqual(
      confirmed.plan!.order.map((item) => item.householdId),
      story === 'squad' ? [] : ['H012'],
    );
    assert.deepEqual(confirmed.plan!.visit, []);
    if (story === 'squad') {
      assert.equal(confirmed.demonstration!.residentRequestAssumed, true);
      assert.equal(status(confirmed, 'H009').status, 'help');
      assert.match(status(confirmed, 'H009').note, /시연 가정/u);
      assert.ok(!confirmed.calls.some((call) => call.targetId === 'H009'));
    }
    const progressing = runtime.tickCycle(1);
    assert.equal(progressing.simMinutes, 1);
    assert.equal(progressing.simulation.phase, 'running');
    assert.equal(progressing.calls.length, 0);
    assert.equal(progressing.trips.length, 0);
    assert.deepEqual(progressing.demonstration!.messages, []);
    assert.equal(progressing.simulation.playing, true);
    assert.deepEqual(runtime.pendingPhoneTargets(), [story === 'squad' ? 'M01' : residentId]);
  });
}

test('H009 is an assumed rescue request and cannot be prepared or reserved as an actual call', () => {
  const { runtime, confirmed } = start('squad');
  assert.throws(() => runtime.preparePhoneCall('H009', 'forbidden-resident'), /실전화 시연 대상/u);
  assert.throws(
    () => runtime.reserveLive('H009', 'resident', 'legacy-forbidden', confirmed.revision),
    /실제 전화 대상이 아닙니다/u,
  );
  assert.deepEqual(runtime.view(), confirmed);
  assert.deepEqual(runtime.pendingPhoneTargets(), ['M01']);
  assert.equal(runtime.tickCycle(1).simMinutes, 1);
  assert.equal(runtime.view().calls.length, 0);
});

test('live request, connected phase and verified outcome are idempotent and do not classify early', () => {
  const { runtime, residentId } = start();
  const prepared = runtime.preparePhoneCall(residentId, 'request-one');
  assert.equal(prepared.demonstration!.stage, 'dialing');
  assert.equal(
    prepared.calls.filter((call) => ['calling', 'pendingunknown'].includes(call.phase)).length,
    1,
  );
  assert.deepEqual(runtime.preparePhoneCall(residentId, 'request-one', -1), prepared);
  assert.throws(() => runtime.preparePhoneCall('M02', 'request-one'), /다른 대상/u);
  assert.throws(() => runtime.preparePhoneCall(residentId, 'another-request'), /세션이 사용 중/u);
  assert.throws(() => runtime.settleLive('request-one', null, 'mock'), /모의 어댑터/u);
  const talking = runtime.applyPhoneUpdate('request-one', {
    phase: 'talking',
    providerId: 'actual-provider',
  });
  assert.equal(talking.demonstration!.stage, 'talking');
  assert.equal(status(talking, residentId).status, 'calling');
  assert.ok(!talking.trips.some((trip) => trip.householdId === residentId));
  assert.deepEqual(
    runtime.applyPhoneUpdate('request-one', {
      phase: 'talking',
      providerId: 'actual-provider',
    }),
    talking,
  );
  assert.throws(
    () =>
      runtime.command('transcript', {
        id: residentId,
        text: '차량으로 데리러 와 주세요',
      }),
    /종료가 확인된/u,
  );
  assert.throws(
    () =>
      runtime.applyPhoneOutcome('request-one', {
        ended: false,
        kind: 'resident',
        mobility: 'needs_help',
      } as unknown as PhoneRuntimeOutcome),
    /종료 확인/u,
  );
  assert.deepEqual(runtime.view(), talking);
  const ended = residentOutcome(runtime, 'request-one');
  assert.equal(ended.calls.find((call) => call.id === 'request-one')!.phase, 'finished');
  assert.equal(status(ended, residentId).status, 'help');
  assert.equal(ended.demonstration!.phoneClockHeld, false);
  assert.equal(ended.demonstration!.stage, 'requested');
  assert.deepEqual(residentOutcome(runtime, 'request-one', 'possible'), ended);
  assert.deepEqual(runtime.applyPhoneUpdate('request-one', { phase: 'dialing' }), ended);
});

test('verified grandfather rescue uses declared transport resources without crew calls and completes on route evidence', () => {
  const { runtime, residentId } = start();
  const id = request(runtime, residentId);
  const ended = residentOutcome(runtime, id);
  assert.equal(ended.memberResponses.M02, 'ok');
  assert.equal(ended.demonstration!.transportCrewAssumed, true);
  assert.ok(!ended.trips.some((trip) => trip.householdId === residentId));
  const dispatched = runtime.tickCycle(1);
  const trip = dispatched.trips.find((trip) => trip.householdId === residentId)!;
  assert.ok(trip);
  assert.equal(trip.vehicleId, 'V01');
  assert.equal(trip.driverRef, 'M02');
  assert.equal(dispatched.demonstration!.stage, 'responding');
  assert.equal(dispatched.memberResponses.M02, 'ok');
  assert.deepEqual(dispatched.demonstration!.messages, []);
  assert.ok(
    !dispatched.shelterAdmissions.some((admission) => admission.householdId === residentId),
  );
  const pickup = runtime.tickCycle(Math.ceil(trip.arriveSim * 1e6) / 1e6 - dispatched.simMinutes);
  assert.equal(pickup.demonstration!.stage, 'boarding');
  const boarded = runtime.tickCycle(Math.ceil(trip.boardSim * 1e6) / 1e6 - pickup.simMinutes);
  assert.equal(boarded.demonstration!.stage, 'evacuating');
  assert.ok(!boarded.shelterAdmissions.some((admission) => admission.householdId === residentId));
  const arrived = runtime.tickCycle(Math.ceil(trip.shelterSim * 1e6) / 1e6 - boarded.simMinutes);
  assert.equal(arrived.demonstration!.stage, 'completed');
  assert.ok(arrived.shelterAdmissions.some((admission) => admission.tripId === trip.id));
  assert.equal(status(arrived, residentId).status, 'rescued');
  assert.deepEqual(arrived.demonstration!.messages, []);
  assert.equal(arrived.calls.filter((call) => call.targetId === residentId).length, 1);
  assert.equal(arrived.calls.length, 1);
  assert.ok(arrived.calls.every((call) => call.mode === 'telnyx'));
});

test('squad rescue waits for actual named-member termination and two confirmed crew members', () => {
  const { runtime, residentId } = start('squad');
  assert.equal(status(runtime.view(), residentId).status, 'help');
  assert.equal(runtime.view().demonstration!.residentRequestAssumed, true);
  assert.deepEqual(runtime.pendingPhoneTargets(), ['M01']);
  assert.equal(runtime.view().demonstration!.phoneClockHeld, false);
  assert.equal(runtime.tickCycle(0.5).simMinutes, 0.5);
  assert.throws(
    () => runtime.command('dispatch', { id: residentId, vehicleId: 'V04' }),
    /실전화 종료/u,
  );
  const memberId = request(runtime, 'M01');
  assert.equal(runtime.view().memberResponses.M01, 'waiting');
  assert.equal(runtime.tickCycle(0.5).simMinutes, 1);
  assert.equal(runtime.view().trips.length, 0);
  runtime.applyPhoneOutcome(memberId, {
    ended: true,
    kind: 'standby',
    standbyAvailable: true,
    evidence: '차량 운전 가능하고 즉시 출동하겠습니다.',
  });
  const view = runtime.tickCycle(1);
  const trip = view.trips.find((trip) => trip.householdId === residentId)!;
  assert.ok(trip);
  assert.equal(trip.driverRef, 'M01');
  assert.equal(trip.vehicleId, 'V04');
  assert.ok(trip.crewMemberIds.length >= 2);
  assert.ok(trip.crewMemberIds.every((id) => view.memberResponses[id] === 'ok'));
  assert.equal(view.demonstration!.stage, 'responding');
  assert.equal(view.calls.length, 1);
  assert.equal(view.calls[0].targetId, 'M01');
  assert.equal(view.calls[0].mode, 'telnyx');
  assert.ok(!view.calls.some((call) => call.targetId === 'H009'));
  assert.deepEqual(view.demonstration!.messages, []);
});

for (const available of [false, undefined]) {
  test(`unavailable or unconfirmed named-member response (${available}) never dispatches or redials`, () => {
    const { runtime, residentId } = start('squad');
    runtime.applyPhoneOutcome(request(runtime, 'M01'), {
      ended: true,
      kind: 'standby',
      standbyAvailable: available,
    });
    const view = runtime.tickCycle(40);
    assert.ok(!view.trips.some((trip) => trip.householdId === residentId));
    assert.ok(!view.completedTrips.some((trip) => trip.householdId === residentId));
    assert.ok(!view.shelterAdmissions.some((admission) => admission.householdId === residentId));
    assert.equal(view.memberResponses.M01, available === false ? 'no' : 'waiting');
    assert.match(status(view, residentId).dispatchHold!, /대원 실전화.*배차 보류/u);
    assert.equal(view.calls.filter((call) => call.targetId === 'M01').length, 1);
    assert.deepEqual(runtime.pendingPhoneTargets(), []);
    assert.equal(view.demonstration!.stage, 'requested');
    assert.deepEqual(view.demonstration!.messages, []);
  });
}

for (const mobility of ['possible', 'refusal', 'unknown'] as const) {
  test(`resident ${mobility} assessment does not imply rescue, arrival, departure or synthetic follow-up`, () => {
    const { runtime, residentId } = start();
    residentOutcome(runtime, request(runtime, residentId), mobility);
    assert.deepEqual(runtime.pendingPhoneTargets(), []);
    const view = runtime.tickCycle(40);
    assert.equal(
      status(view, residentId).status,
      mobility === 'possible' ? 'guided' : mobility === 'refusal' ? 'refuse' : 'unclear',
    );
    assert.ok(!view.trips.some((trip) => trip.householdId === residentId));
    assert.ok(!view.completedTrips.some((trip) => trip.householdId === residentId));
    assert.ok(!view.shelterAdmissions.some((admission) => admission.householdId === residentId));
    assert.equal(view.calls.filter((call) => call.targetId === residentId).length, 1);
    assert.equal(view.calls.filter((call) => call.targetId === 'M01').length, 0);
    assert.equal(status(view, residentId).callbackAtSim, null);
    assert.equal(view.demonstration!.stage, 'assessed');
    assert.deepEqual(view.demonstration!.messages, []);
  });
}

test('real emergency is retained for human medical review without fabricating a 119 receipt or ambulance dispatch', () => {
  const { runtime, residentId } = start();
  runtime.applyPhoneOutcome(request(runtime, residentId), {
    ended: true,
    kind: 'resident',
    mobility: 'needs_help',
    emergency: true,
    evidence: '숨쉬기 힘들어요.',
  });
  const view = runtime.tickCycle(40);
  assert.equal(status(view, residentId).status, 'e119');
  assert.equal(view.demonstration!.stage, 'assessed');
  assert.ok(status(view, residentId).dispatchHold);
  assert.ok(!view.handoffs.some((handoff) => handoff.householdId === residentId));
  assert.ok(!view.trips.some((trip) => trip.householdId === residentId));
  assert.ok(!view.completedTrips.some((trip) => trip.householdId === residentId));
  assert.throws(
    () => runtime.command('dispatch', { id: residentId, vehicleId: 'V01' }),
    /실전화 종료/u,
  );
});

test('a human pause during a live call preserves speed and remains paused after termination', () => {
  const { runtime, residentId } = start();
  request(runtime, residentId);
  runtime.command('sim', { revision: runtime.view().revision, speed: 60, playing: false });
  const ended = residentOutcome(runtime, `phone-${residentId}`);
  assert.equal(ended.simulation.speed, 60);
  assert.equal(ended.simulation.playing, false);
  assert.equal(ended.demonstration!.phoneClockHeld, false);
  assert.deepEqual(runtime.tickCycle(500), ended);
  runtime.command('sim', { revision: runtime.view().revision, playing: true });
  const resumed = runtime.tickCycle(1);
  assert.equal(resumed.simulation.speed, 60);
  assert.ok(resumed.trips.some((trip) => trip.householdId === residentId));
});

test('unknown provider state and a termination without assessment keep reset and close blocked across restart', () => {
  const { runtime, residentId } = start();
  const id = request(runtime, residentId);
  assert.throws(() => runtime.rejectPhoneCall(id, '생성 전 실패라고 주장'), /전화망 생성/u);
  runtime.rejectPhoneCall(id, '전화망 응답을 확인할 수 없음', true);
  assert.equal(runtime.tickCycle(1).simMinutes, 1);
  assert.throws(() => runtime.command('close', { acknowledged: true }), /실제 통화 종료/u);
  assert.throws(() => runtime.command('scenario', { id: 'idle' }), /실제 세션/u);
  assert.throws(
    () => runtime.command('cycle-start', { revision: runtime.view().revision }),
    /실제 활성/u,
  );
  runtime.finishLive(id);
  assert.equal(runtime.view().demonstration!.phoneClockHeld, false);
  const unassessed = runtime.tickCycle(1);
  assert.equal(unassessed.simMinutes, 2);
  assert.equal(unassessed.trips.length, 0);
  assert.equal(unassessed.simulation.phase, 'running');
  assert.throws(() => runtime.command('close', { acknowledged: true }), /실제 통화 종료/u);
  const restored = new Runtime();
  restored.restore(runtime.view());
  assert.equal(restored.view().demonstration!.phoneClockHeld, false);
  assert.throws(
    () => restored.command('cycle-start', { revision: restored.view().revision }),
    /실제 활성/u,
  );
  const resolved = residentOutcome(restored, id, 'unknown');
  assert.equal(resolved.demonstration!.phoneClockHeld, false);
});

test('proven pre-dial failure ends the local request without a synthetic result or automatic retry', () => {
  const { runtime, residentId } = start();
  runtime.preparePhoneCall(residentId, 'preflight-failed');
  const rejected = runtime.rejectPhoneCall('preflight-failed', '공개 callback URL 검증 실패');
  const call = rejected.calls.find((call) => call.id === 'preflight-failed')!;
  assert.equal(call.phase, 'finished');
  assert.equal(call.outcome, 'unavailable');
  assert.equal(call.phoneNotDialed, true);
  assert.equal(call.providerId, null);
  assert.equal(status(rejected, residentId).status, 'unclear');
  assert.equal(rejected.demonstration!.stage, 'assessed');
  assert.equal(rejected.demonstration!.phoneClockHeld, false);
  assert.deepEqual(runtime.pendingPhoneTargets(), []);
  assert.deepEqual(runtime.rejectPhoneCall('preflight-failed', '중복 실패'), rejected);
  const view = runtime.tickCycle(40);
  assert.equal(view.calls.filter((call) => call.targetId === residentId).length, 1);
  assert.ok(!view.completedTrips.some((trip) => trip.householdId === residentId));
  assert.deepEqual(view.demonstration!.messages, []);
});

test('delayed phone events from the previous cycle cannot modify a new cycle', () => {
  const { runtime, residentId } = start();
  residentOutcome(runtime, request(runtime, residentId), 'unknown');
  const next = runtime.command('cycle-start', {
    revision: runtime.view().revision,
    demoStory: 'squad',
    phoneMode: 'live',
  });
  assert.throws(
    () => runtime.applyPhoneUpdate(`phone-${residentId}`, { phase: 'talking' }),
    /현재 사이클/u,
  );
  assert.throws(() => residentOutcome(runtime, `phone-${residentId}`), /현재 사이클/u);
  assert.deepEqual(runtime.view(), next);
});

test('old snapshots default to mock while a new live cycle cannot inherit mock core responses', () => {
  const runtime = new Runtime();
  const review = runtime.command('cycle-start', { revision: runtime.view().revision });
  const old = runtime.command('confirm', { revision: review.revision });
  delete old.demonstration!.phoneMode;
  const restored = new Runtime();
  restored.restore(old);
  restored.command('comms', { down: false });
  restored.command('sim', { revision: restored.view().revision, playing: true });
  assert.equal(restored.view().demonstration!.phoneMode, 'mock');
  assert.equal(restored.view().demonstration!.phoneClockHeld, false);
  assert.ok(restored.tickCycle(1).trips.some((trip) => trip.householdId === 'H012'));
  const next = restored.command('cycle-start', {
    revision: restored.view().revision,
    phoneMode: 'live',
    demoStory: 'squad',
  });
  assert.deepEqual(next.demonstration!.messages, []);
  assert.equal(next.memberResponses.M01, 'waiting');
  assert.equal(next.calls.length, 0);
  assert.equal(next.trips.length, 0);
});
