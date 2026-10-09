import test from 'node:test';
import assert from 'node:assert/strict';
import { Runtime } from '../../shared/src/runtime.ts';
import { dispatchSafety } from '../../shared/src/dispatch.ts';
import { predictionEvidence } from '../../shared/src/monitoring.ts';
import { forestFrame, forestPropagation } from '../../fe/src/components/map/forest.ts';
import { SimulationClock, type SimulationTimer } from '../src/simulation.ts';

class FakeClock implements SimulationTimer {
  milliseconds = 0;
  callback: (() => void) | null = null;
  now = () => this.milliseconds;
  setInterval(callback: () => void) {
    this.callback = callback;
    return callback;
  }
  clearInterval() {
    this.callback = null;
  }
}

for (const story of ['grandfather', 'squad'] as const) {
  for (const talkMinutes of [1, 3]) {
    test(`${story}: live clock and fire continue through a ${talkMinutes}-minute conversation; only a verified ended result starts rescue`, async (t) => {
      const runtime = new Runtime();
      const review = runtime.command('cycle-start', {
        revision: runtime.view().revision,
        demoStory: story,
        phoneMode: 'live',
      });
      const initial = runtime.command('confirm', { revision: review.revision });
      const demonstration = initial.demonstration!;
      const targetId = story === 'squad' ? 'M01' : demonstration.residentId;
      const requestId = `clock-${story}-${talkMinutes}`;
      const fake = new FakeClock();
      const clock = new SimulationClock(
        // Legacy saved flags cannot suppress the clock after upgrading an active call.
        () => ({
          ...runtime.view(),
          demonstration: { ...runtime.view().demonstration!, phoneClockHeld: true },
        }),
        async (delta) => {
          runtime.tickCycle(delta);
        },
        async (work) => work(),
        { now: fake.now, timer: fake },
      );
      t.after(() => clock.close());
      const fire = forestPropagation(initial.data.map);
      const initialEta = dispatchSafety(initial, demonstration.residentId).targetEta!;
      let minutes = 0;
      async function advance(delta: number) {
        minutes += delta;
        fake.milliseconds += (delta * 60000) / initial.simulation.speed;
        fake.callback!();
        await clock.pulse();
        const view = runtime.view();
        assert.equal(view.simMinutes, minutes);
        assert.equal(view.simulation.playing, true);
        assert.equal(view.demonstration!.phoneClockHeld, false);
        assert.equal(view.simulation.phase, 'running');
        assert.equal(view.trips.length, 0);
        assert.equal(view.completedTrips.length, 0);
        assert.equal(view.shelterAdmissions.length, 0);
        assert.deepEqual(view.demonstration!.messages, []);
        assert.equal(predictionEvidence(view).usable, true);
        assert.ok(dispatchSafety(view, demonstration.residentId).targetEta! < initialEta);
        return view;
      }

      await advance(0.5); // The adapter has not created the actual call yet.
      assert.deepEqual(runtime.pendingPhoneTargets(), [targetId]);
      runtime.preparePhoneCall(targetId, requestId);
      await advance(0.5); // Dialing.
      runtime.applyPhoneUpdate(requestId, { phase: 'talking', providerId: 'local-test-only' });
      const beforeTalk = runtime.view();
      const talking = await advance(talkMinutes);
      assert.deepEqual(talking.calls, beforeTalk.calls);
      assert.ok(
        forestFrame(fire, talking.simMinutes).cells.length >
          forestFrame(fire, beforeTalk.simMinutes).cells.length,
      );
      runtime.applyPhoneUpdate(requestId, { phase: 'pendingunknown' });
      const unknown = runtime.view().calls[0];
      const waiting = await advance(0.5); // Provider ending or unknown; no synthetic timeout.
      assert.deepEqual(waiting.calls[0], unknown);
      assert.deepEqual(runtime.pendingPhoneTargets(), []);
      assert.throws(() => runtime.command('close', { acknowledged: true }), /실제 통화 종료/u);
      runtime.finishLive(requestId);
      await advance(0.5); // Ended without an assessment still cannot dispatch.
      assert.throws(
        () =>
          runtime.command('dispatch', {
            id: demonstration.residentId,
            vehicleId: demonstration.vehicleId,
          }),
        /실전화 종료/u,
      );
      runtime.applyPhoneOutcome(requestId, {
        ended: true,
        ...(story === 'squad'
          ? { kind: 'standby' as const, standbyAvailable: true }
          : { kind: 'resident' as const, mobility: 'needs_help' as const }),
        evidence: 'Local test evidence for confirmed help and dispatch availability.',
      });
      fake.milliseconds += 2000;
      await clock.pulse();
      const dispatched = runtime.view();
      const trip = dispatched.trips.find(
        (value) => value.householdId === demonstration.residentId,
      )!;
      assert.ok(trip);
      assert.equal(trip.departSim, minutes);
      assert.equal(trip.vehicleId, demonstration.vehicleId);
      assert.equal(dispatched.calls.length, 1);
      assert.equal(dispatched.calls[0].targetId, targetId);
      assert.deepEqual(runtime.pendingPhoneTargets(), []);
      assert.ok(!dispatched.calls.some((call) => call.targetId === 'H009'));
      const arrival = Math.ceil(trip.shelterSim * 1_000_000) / 1_000_000;
      fake.milliseconds += ((arrival - dispatched.simMinutes) * 60000) / initial.simulation.speed;
      await clock.pulse();
      const rescued = runtime.view();
      assert.equal(rescued.demonstration!.stage, 'completed');
      assert.ok(rescued.shelterAdmissions.some((admission) => admission.tripId === trip.id));
      assert.equal(rescued.calls.length, 1);
      assert.equal(rescued.sourceState.actualModelCalls, 0);
    });
  }
}
