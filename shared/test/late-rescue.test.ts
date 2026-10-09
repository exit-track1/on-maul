import test from 'node:test';
import assert from 'node:assert/strict';
import { Runtime, type View } from '../src/runtime.ts';
import { tripPosition } from '../src/dispatch.ts';

function lateRescue(story: 'grandfather' | 'squad', callEnd = 35.03396) {
  const runtime = new Runtime();
  const review = runtime.command('cycle-start', {
    revision: runtime.view().revision,
    demoStory: story,
    phoneMode: 'live',
  });
  runtime.command('confirm', { revision: review.revision });
  const targetId = story === 'squad' ? 'M01' : 'H012';
  runtime.preparePhoneCall(targetId, 'late-call');
  runtime.applyPhoneUpdate('late-call', { phase: 'talking' });
  const talking = runtime.tickCycle(callEnd);
  assert.equal(talking.simMinutes, callEnd);
  assert.equal(talking.simulation.phase, 'running');
  assert.equal(talking.trips.length, 0);
  runtime.applyPhoneOutcome('late-call', {
    ended: true,
    ...(story === 'squad'
      ? { kind: 'standby' as const, standbyAvailable: true }
      : { kind: 'resident' as const, mobility: 'needs_help' as const }),
    evidence: '테스트: 이동 가능·차량 보유·즉시 출동 확인',
  });
  const dispatched = runtime.tickCycle(0.001);
  assert.equal(dispatched.trips.length, 1);
  return { runtime, trip: dispatched.trips[0] };
}

function until(runtime: Runtime, time: number) {
  return runtime.tickCycle(Math.max(0, time - runtime.view().simMinutes) + 0.00001);
}

for (const story of ['grandfather', 'squad'] as const) {
  for (const callEnd of [35.03396, 43.1]) {
    test(`${story}: late live rescue at ${callEnd} minutes transports to shelter and returns past the default deadline`, () => {
      const { runtime, trip } = lateRescue(story, callEnd);
      assert.ok(trip.shelterSim > 40);
      const boarded = until(runtime, Math.ceil(trip.boardSim * 1e6) / 1e6);
      assert.equal(boarded.trips[0].stage, 'boarded');
      assert.equal(boarded.demonstration!.stage, 'evacuating');
      assert.equal(boarded.simulation.phase, 'running');
      assert.ok(boarded.simulation.durationMinutes >= trip.returnSim);
      const before = tripPosition(boarded.trips[0], boarded.simMinutes);
      const moving = runtime.tickCycle((trip.shelterSim - boarded.simMinutes) / 2);
      assert.notDeepEqual(tripPosition(moving.trips[0], moving.simMinutes), before);
      assert.equal(moving.trips[0].heldReason, null);
      assert.equal(moving.simulation.playing, true);
      const arrived = until(runtime, Math.ceil(trip.shelterSim * 1e6) / 1e6);
      assert.equal(arrived.demonstration!.stage, 'completed');
      assert.equal(arrived.shelterAdmissions.filter((a) => a.tripId === trip.id).length, 1);
      assert.equal(arrived.trips[0].stage, 'shelter');
      const returned = until(runtime, Math.ceil(trip.returnSim * 1e6) / 1e6);
      assert.equal(returned.trips.length, 0);
      assert.equal(returned.completedTrips.length, 1);
      assert.equal(returned.simulation.phase, 'awaiting_handover');
      assert.equal(returned.calls.length, 1);
      assert.equal(returned.calls[0].targetId, story === 'squad' ? 'M01' : 'H012');
      assert.ok(!returned.calls.some((call) => call.targetId === 'H009'));
    });
  }
}

function stoppedSnapshot(): View {
  const { runtime } = lateRescue('squad');
  const snapshot = until(runtime, 40);
  assert.equal(snapshot.trips[0].stage, 'boarded');
  snapshot.simulation.phase = 'awaiting_handover';
  snapshot.simulation.playing = false;
  snapshot.simulation.durationMinutes = 40;
  snapshot.simulation.endReason = '합성 40분 도달·미해결·방문·보류 임무의 담당자 인수인계 필요';
  return snapshot;
}

test('a saved transport stopped at 40 minutes can resume the same passengers and route without another call', () => {
  const snapshot = stoppedSnapshot();
  const runtime = new Runtime();
  runtime.restore(snapshot);
  const recovered = runtime.view();
  assert.equal(recovered.simulation.phase, 'running');
  assert.equal(recovered.simulation.playing, false);
  assert.equal(recovered.simulation.endReason, null);
  assert.equal(recovered.networkDown, true);
  assert.deepEqual(recovered.trips, snapshot.trips);
  assert.deepEqual(recovered.shelterAdmissions, snapshot.shelterAdmissions);
  runtime.command('comms', { down: false });
  runtime.command('sim', { revision: runtime.view().revision, playing: true });
  const trip = recovered.trips[0];
  const resumed = runtime.tickCycle(0.5);
  assert.ok(resumed.simMinutes > 40);
  assert.notDeepEqual(tripPosition(resumed.trips[0], resumed.simMinutes), tripPosition(trip, 40));
  const arrived = until(runtime, Math.ceil(trip.shelterSim * 1e6) / 1e6);
  assert.equal(arrived.demonstration!.stage, 'completed');
  assert.equal(arrived.shelterAdmissions.length, 1);
  assert.equal(arrived.calls.length, 1);
});

test('held transport and closed reports keep their original stop and safety guards', () => {
  const held = stoppedSnapshot();
  held.trips[0].heldReason = '경로 통제 변경·담당자 확인 필요';
  held.trips[0].heldAtSim = 40;
  const runtime = new Runtime();
  runtime.restore(held);
  assert.equal(runtime.view().simulation.phase, 'awaiting_handover');
  assert.equal(runtime.tickCycle(5).simMinutes, held.simMinutes);
  const closed = stoppedSnapshot();
  closed.frozen = true;
  closed.simulation.phase = 'ended';
  const frozen = new Runtime();
  frozen.restore(closed);
  assert.deepEqual(frozen.view(), closed);
  assert.equal(frozen.tickCycle(5).simMinutes, closed.simMinutes);
});
