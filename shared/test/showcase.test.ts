import test from 'node:test';
import assert from 'node:assert/strict';
import { ShowcaseRuntime, showcaseMotions } from '../src/showcase.ts';
import { SHOWCASE_CASES } from '../src/showcase-cases.ts';
import { routeIsOpen } from '../src/routing.ts';

for (const seed of [1, 42, 777, 20261010]) {
  test(`seed ${seed}: every branch and all 48 households finish; resources are never double booked`, () => {
    const runtime = new ShowcaseRuntime(seed);
    runtime.command('sim', { autoRepeat: false });
    let view = runtime.view();
    const moved = new Set<string>();
    for (let i = 0; i < 500 && view.showcase!.stage !== 'completed'; i++) {
      view = runtime.tickCycle(0.5);
      const actors = view.showcase!.actors;
      const booked = actors.filter((a) => a.vehicleId && a.phase !== 'completed');
      assert.equal(new Set(booked.map((a) => a.vehicleId)).size, booked.length);
      assert.equal(new Set(booked.map((a) => a.rescuerId)).size, booked.length);
      for (const actor of booked) {
        const vehicle = view.data.vehicles.find((v) => v.id === actor.vehicleId)!;
        assert.ok(vehicle.capacity >= actor.passengers + 1);
        if (actor.caseId === 'wheelchair' && actor.mode !== 'ambulance')
          assert.ok(vehicle.equipment.includes('휠체어'));
      }
      for (const motion of showcaseMotions(view)) {
        assert.ok(routeIsOpen(view.data.map, motion.route), motion.householdId);
        if (motion.stage === 'evacuating') moved.add(motion.householdId);
      }
    }
    assert.equal(view.showcase!.stage, 'completed');
    assert.equal(view.simulation.playing, false);
    assert.equal(view.scenario.counts.safe, 48);
    assert.equal(view.shelterAdmissions.length, 48);
    for (const actor of view.showcase!.actors.filter((a) =>
      ['wheelchair', 'guardian'].includes(a.caseId),
    ))
      assert.equal(
        view.shelterAdmissions.find((a) => a.householdId === actor.householdId)!.passengerCount,
        2,
      );
    assert.equal(moved.size, 48);
    assert.ok(view.showcase!.actors.every((a) => a.phase === 'completed' && a.moved));
    assert.deepEqual([...view.showcase!.seenCases].sort(), SHOWCASE_CASES.map((c) => c.id).sort());
    assert.ok(view.showcase!.calls.every((c) => c.phase === 'completed'));
    const replacement = view.showcase!.calls.filter((c) =>
      ['busy', 'decline', 'rescue-retry', 'delay'].includes(c.caseId),
    );
    assert.ok(
      replacement.every((c) => c.candidateIds.length === 2 && new Set(c.candidateIds).size === 2),
    );
  });
}
test('both named calls start together; ambulance moves only after resident and dispatch calls finish', () => {
  const runtime = new ShowcaseRuntime(42);
  let view = runtime.view();
  assert.equal(view.showcase!.calls.length, 2);
  assert.equal(view.showcase!.calls[0].targetName, '반영환 할아버지');
  assert.equal(view.showcase!.calls[1].targetName, '반영환 대원');
  assert.equal(view.showcase!.calls[1].householdId, 'H009');
  assert.ok(!view.showcase!.calls.some((c) => c.targetId === 'H009'));
  for (let i = 0; i < 35; i++) {
    view = runtime.tickCycle(0.2);
    const actor = view.showcase!.actors.find((a) => a.householdId === 'H012')!;
    if (actor.phase === 'pickup') {
      assert.ok(
        view
          .showcase!.calls.filter((c) => c.householdId === 'H012')
          .every((c) => c.phase === 'completed'),
      );
      assert.ok(actor.vehicleId);
      return;
    }
  }
  assert.fail('Grandfather ambulance pickup did not start');
});
test('boarding always transitions to shelter transport and then resource return', () => {
  const runtime = new ShowcaseRuntime(7);
  const phases: string[] = [];
  for (let i = 0; i < 120; i++) {
    const actor = runtime.tickCycle(0.25).showcase!.actors.find((a) => a.householdId === 'H009')!;
    if (phases.at(-1) !== actor.phase) phases.push(actor.phase);
    if (actor.phase === 'completed') break;
  }
  assert.deepEqual(phases, [
    'dispatch-call',
    'pickup',
    'boarding',
    'evacuating',
    'returning',
    'completed',
  ]);
});
test('pause freezes calls and map; reset clears past calls and stays at start until resumed', () => {
  const runtime = new ShowcaseRuntime(2);
  runtime.tickCycle(8);
  const paused = runtime.command('sim', { playing: false });
  assert.deepEqual(runtime.tickCycle(20), paused);
  const reset = runtime.command('demo-reset');
  assert.equal(reset.simMinutes, 0);
  assert.equal(reset.showcase!.calls.length, 0);
  assert.equal(reset.showcase!.seenCases.length, 0);
  assert.equal(reset.shelterAdmissions.length, 0);
  assert.equal(reset.simulation.playing, false);
  assert.equal(reset.showcase!.loop, 1);
  assert.ok(reset.showcase!.actors.every((a) => !a.moved));
  assert.equal(runtime.command('sim', { playing: true }).showcase!.calls.length, 2);
});
test('automatic repeat starts a fresh shuffled round only after every household and vehicle is done', () => {
  const runtime = new ShowcaseRuntime(99);
  let view = runtime.view();
  const before = view.showcase!.actors.map((a) => a.caseId);
  while (view.showcase!.stage !== 'completed') view = runtime.tickCycle(0.5);
  assert.equal(view.showcase!.seenCases.length, 28);
  assert.equal(view.scenario.counts.safe, 48);
  const completedAt = view.showcase!.completedAt!;
  view = runtime.tickCycle(1);
  assert.equal(view.showcase!.loop, 1);
  view = runtime.tickCycle(6);
  assert.equal(view.showcase!.loop, 2);
  assert.ok(view.simMinutes < completedAt);
  assert.notDeepEqual(
    view.showcase!.actors.map((a) => a.caseId),
    before,
  );
  assert.ok(view.showcase!.calls.every((c) => c.id.startsWith('call-2-')));
});
test('old dialing, real transcript and arbitrary scenario actions cannot enter the simulation', () => {
  const runtime = new ShowcaseRuntime();
  for (const action of ['dial', 'transcript', 'cycle-start', 'scenario', 'member-response'])
    assert.throws(() => runtime.command(action, { phoneMode: 'live' }), /로컬 모의/);
  assert.throws(() => runtime.tickCycle(NaN));
  assert.throws(() => runtime.command('sim', { speed: 99 }));
});
