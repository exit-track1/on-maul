import test from 'node:test';
import assert from 'node:assert/strict';
import { DATA } from '../src/data.ts';
import { Runtime } from '../src/runtime.ts';
import { dispatchSafety, evaluateDispatch, tripPosition } from '../src/dispatch.ts';
import { findDemoRoute, routeIsOpen, routePosition } from '../src/routing.ts';

function ready() {
  const data = structuredClone(DATA);
  data.map.ignition = { x: 0, y: 0 };
  data.map.wind = { direction: 270, speedMps: 0 };
  for (const h of data.households) {
    h.demoPosition = { x: 900, y: 550 };
    h.mobility = '자력';
    h.devices = [];
    h.shelterId = 'S2';
  }
  const r = new Runtime(data);
  r.command('watch');
  r.command('plan');
  r.command('confirm', { revision: r.view().revision });
  const snapshot = r.view();
  // Isolate dispatch from the separate call scheduler with a synthetic restored response snapshot.
  snapshot.calls.forEach((c) => {
    c.phase = 'finished';
  });
  snapshot.scenario.householdStatuses.forEach((s) => {
    s.status = snapshot.data.households.find((h) => h.id === s.householdId)!.callEligible
      ? 'help'
      : 'visit';
  });
  snapshot.memberResponses = Object.fromEntries(
    data.teams.flatMap((t) =>
      t.members.map((m) => [m.id, m.availability === '가능' ? ('ok' as const) : ('no' as const)]),
    ),
  );
  r.restore(snapshot);
  r.command('comms', { down: false });
  return r;
}
test('road topology detours around a closed segment instead of authorizing a straight shortcut', () => {
  const map = structuredClone(DATA.map);
  map.roads = [
    {
      id: 'closed',
      label: '통제',
      blocked: true,
      points: [
        [100, 0],
        [300, 0],
      ],
    },
    {
      id: 'left',
      label: '왼쪽',
      blocked: false,
      points: [
        [100, 0],
        [100, 100],
      ],
    },
    {
      id: 'bottom',
      label: '아래',
      blocked: false,
      points: [
        [100, 100],
        [300, 100],
      ],
    },
    {
      id: 'right',
      label: '오른쪽',
      blocked: false,
      points: [
        [300, 100],
        [300, 0],
      ],
    },
  ];
  const route = findDemoRoute(map, { x: 100, y: 0 }, { x: 300, y: 0 })!;
  assert.ok(route);
  assert.equal(route.distanceMeters, 800);
  assert.deepEqual(route.waypoints, [
    { x: 100, y: 0 },
    { x: 100, y: 100 },
    { x: 300, y: 100 },
    { x: 300, y: 0 },
  ]);
  assert.equal(routeIsOpen(map, route), true);
  assert.deepEqual(routePosition(route, 0.5), { x: 200, y: 100 });
  map.roads.find((r) => r.id === 'bottom')!.blocked = true;
  assert.equal(routeIsOpen(map, route), false);
  assert.equal(findDemoRoute(map, { x: 100, y: 0 }, { x: 300, y: 0 }), null);
});
test('disconnected road components and unbounded local access cannot create a route', () => {
  const map = structuredClone(DATA.map);
  map.roads = [
    {
      id: 'a',
      label: 'a',
      blocked: false,
      points: [
        [0, 0],
        [100, 0],
      ],
    },
    {
      id: 'b',
      label: 'b',
      blocked: false,
      points: [
        [400, 0],
        [500, 0],
      ],
    },
  ];
  assert.equal(findDemoRoute(map, { x: 0, y: 0 }, { x: 500, y: 0 }), null);
  assert.equal(findDemoRoute(map, { x: 0, y: 300 }, { x: 100, y: 0 }), null);
  assert.equal(findDemoRoute(map, { x: NaN, y: 0 }, { x: 100, y: 0 }), null);
});
test('open-road crossing is a connected junction even when it is not an existing endpoint', () => {
  const map = structuredClone(DATA.map);
  map.roads = [
    {
      id: 'a',
      label: 'a',
      blocked: false,
      points: [
        [0, 0],
        [100, 100],
      ],
    },
    {
      id: 'b',
      label: 'b',
      blocked: false,
      points: [
        [0, 100],
        [100, 0],
      ],
    },
  ];
  const route = findDemoRoute(map, { x: 0, y: 0 }, { x: 100, y: 0 })!;
  assert.ok(route.waypoints.some((p) => p.x === 50 && p.y === 50));
  assert.ok(Math.abs(route.distanceMeters - 200 * Math.sqrt(2)) < 1e-6);
});
test('zone ETA 12 blocks a general crew even with target ETA 20 and records automatic mock handoff atomically', () => {
  const r = ready(),
    v = r.view();
  v.data.households.find((h) => h.id === 'H001')!.demoPosition = { x: 250, y: 0 };
  v.data.households.find((h) => h.id === 'H003')!.demoPosition = { x: 150, y: 0 };
  r.restore(v);
  r.command('comms', { down: false });
  assert.ok(Math.abs(dispatchSafety(r.view(), 'H001').targetEta! - 20) < 1e-6);
  assert.ok(Math.abs(dispatchSafety(r.view(), 'H001').zoneEta! - 12) < 1e-6);
  const oldRevision = r.view().revision;
  const held = r.command('dispatch', { id: 'H001', vehicleId: 'V04' });
  assert.equal(held.trips.length, 0);
  assert.equal(held.handoffs.length, 1);
  assert.equal(held.revision, oldRevision + 1);
  assert.equal(held.handoffs[0].status, 'mockRecorded');
  assert.equal(
    held.scenario.householdStatuses.find((s) => s.householdId === 'H001')!.status,
    'e119',
  );
  assert.equal(r.command('dispatch', { id: 'H001', vehicleId: 'V04' }).handoffs.length, 1);
});
test('unknown ETA holds without reserving a vehicle or inventing an emergency receipt', () => {
  const r = ready(),
    v = r.view();
  v.data.map.wind.speedMps = NaN;
  r.restore(v);
  r.command('comms', { down: false });
  assert.throws(() => r.command('dispatch', { id: 'H041', vehicleId: 'V07' }), /ETA 불명/);
  assert.equal(r.view().trips.length, 0);
  assert.equal(r.view().handoffs.length, 0);
});
test('companions count toward vehicle seats and cannot be changed after a trip reserves them', () => {
  const r = ready();
  for (let i = 0; i < 7; i++)
    r.command('companion', {
      id: 'H041',
      companionId: `C${i}`,
      label: '가상 가족',
      mobility: '자력',
      revision: r.view().revision,
    });
  assert.throws(() => r.command('dispatch', { id: 'H041', vehicleId: 'V07' }), /정원/);
  assert.equal(r.view().trips.length, 0);
  const other = ready();
  other.command('dispatch', { id: 'H041', vehicleId: 'V07' });
  assert.throws(
    () =>
      other.command('companion', {
        id: 'H041',
        label: '가상 가족',
        mobility: '자력',
        revision: other.view().revision,
      }),
    /탑승 정원/,
  );
});
test('shelter capacity is reserved by people and remains occupied after the vehicle returns', () => {
  const r = ready(),
    v = r.view();
  v.data.shelters.find((s) => s.id === 'S2')!.capacity = 1;
  r.restore(v);
  r.command('comms', { down: false });
  const t = r.command('dispatch', { id: 'H041', vehicleId: 'V07' }).trips[0];
  assert.throws(() => r.command('dispatch', { id: 'H033', vehicleId: 'V06' }), /정원/);
  for (const stage of ['arrive', 'boarded', 'shelter']) r.command('trip', { id: t.id, stage });
  assert.equal(
    r.view().scenario.resourceStatuses.find((s) => s.vehicleId === 'V07')!.status,
    'returning',
  );
  assert.equal(evaluateDispatch(r.view(), 'H040', 'V07').ok, false);
  r.command('trip', { id: t.id, stage: 'return' });
  assert.equal(r.view().shelterAdmissions.length, 1);
  assert.equal(r.view().completedTrips.length, 1);
  assert.equal(r.view().trips.length, 0);
  assert.throws(() => r.command('dispatch', { id: 'H033', vehicleId: 'V06' }), /정원/);
  r.command('trip', { id: t.id, stage: 'return' });
  assert.equal(r.view().completedTrips.length, 1);
});
test('drivers and support members cannot be borrowed by two simultaneous missions', () => {
  const r = ready();
  r.command('dispatch', { id: 'H041', vehicleId: 'V03' });
  assert.throws(() => r.command('dispatch', { id: 'H033', vehicleId: 'V06' }), /최소 2명/);
  assert.equal(r.view().trips.length, 1);
});
test('validated route timeline advances pickup, boarding, shelter and return with system provenance', () => {
  const r = ready(),
    t = r.command('dispatch', { id: 'H041', vehicleId: 'V07' }).trips[0];
  assert.equal(t.boardSim - t.arriveSim, 3);
  assert.equal(routeIsOpen(r.view().data.map, t.legs.pickup), true);
  assert.deepEqual(tripPosition(t, t.departSim), t.legs.pickup.waypoints[0]);
  assert.notDeepEqual(tripPosition(t, (t.departSim + t.arriveSim) / 2), t.legs.pickup.waypoints[0]);
  for (let i = 0; i < Math.ceil(t.returnSim) + 1; i++) r.command('advance');
  assert.equal(r.view().trips.length, 0);
  assert.equal(r.view().completedTrips.length, 1);
  assert.equal(
    r.view().scenario.householdStatuses.find((s) => s.householdId === 'H041')!.status,
    'rescued',
  );
  assert.ok(
    r
      .view()
      .records.filter((x) => x.label.includes('검증된 경로/시간 재생'))
      .every((x) => x.actorType === 'system'),
  );
});
test('closing a used road holds a trip at its current position without releasing its reservations', () => {
  const r = ready(),
    t = r.command('dispatch', { id: 'H041', vehicleId: 'V07' }).trips[0];
  const held = r.command('road-control', {
    id: t.legs.pickup.roadIds[0],
    blocked: true,
    revision: r.view().revision,
  });
  assert.ok(held.trips[0].heldReason);
  const position = tripPosition(held.trips[0], held.simMinutes);
  r.command('advance');
  assert.deepEqual(tripPosition(r.view().trips[0], r.view().simMinutes), position);
  assert.notEqual(
    r.view().scenario.householdStatuses.find((s) => s.householdId === 'H041')!.status,
    'rescued',
  );
  assert.throws(() => r.command('trip', { id: t.id, stage: 'arrive' }), /보류/);
});
test('reassignment proposal has no effects until human approval; stale revision and duplicate approval cannot double-book', () => {
  const r = ready(),
    proposed = r.command('reassign-propose', { id: 'H041', revision: r.view().revision });
  assert.equal(proposed.trips.length, 0);
  assert.equal(proposed.reassignments.length, 1);
  const p = proposed.reassignments[0],
    selected = p.candidates.find((c) => c.vehicleId)!;
  assert.throws(
    () =>
      r.command('reassign-approve', {
        id: p.id,
        vehicleId: selected.vehicleId,
        revision: proposed.revision - 1,
      }),
    /최신/,
  );
  const approved = r.command('reassign-approve', {
    id: p.id,
    vehicleId: selected.vehicleId,
    revision: r.view().revision,
  });
  assert.equal(approved.trips.length, 1);
  assert.equal(approved.reassignments[0].status, 'approved');
  assert.equal(
    r.command('reassign-approve', {
      id: p.id,
      vehicleId: selected.vehicleId,
      revision: proposed.revision,
    }).trips.length,
    1,
  );
  assert.ok(
    approved.records.some((x) => x.actorType === 'human' && x.label.includes('재배정 승인')),
  );
});
test('reassignment rejection and changed driver response cannot execute a mission', () => {
  const r = ready(),
    p = r.command('reassign-propose', { id: 'H041', revision: r.view().revision }).reassignments[0];
  const v = r.view(),
    candidate = p.candidates.find((c) => c.vehicleId)!;
  v.memberResponses[v.data.vehicles.find((x) => x.id === candidate.vehicleId)!.driverRef] = 'no';
  r.restore(v);
  r.command('comms', { down: false });
  assert.throws(
    () =>
      r.command('reassign-approve', {
        id: p.id,
        vehicleId: candidate.vehicleId,
        revision: r.view().revision,
      }),
    /운전자/,
  );
  assert.equal(r.view().trips.length, 0);
  r.command('reassign-reject', { id: p.id, revision: r.view().revision });
  assert.equal(r.view().reassignments[0].status, 'rejected');
});
test('closed snapshot survives restart with the same counts, records, reservations and metadata', () => {
  const r = ready();
  r.command('dispatch', { id: 'H041', vehicleId: 'V07' });
  const frozen = r.command('close', { acknowledged: true }),
    restored = new Runtime();
  restored.restore(frozen);
  assert.deepEqual(restored.view(), frozen);
});
test('ambulance assignment and boarding keep an emergency unresolved until shelter arrival', () => {
  const r = ready();
  r.command('transcript', { id: 'H012', text: '숨쉬기 힘들어요' });
  const dispatched = r.command('dispatch', { id: 'H012', vehicleId: 'V01' }),
    t = dispatched.trips[0];
  assert.ok(t);
  assert.equal(dispatched.handoffs.length, 1);
  assert.equal(
    dispatched.scenario.householdStatuses.find((s) => s.householdId === 'H012')!.status,
    'e119',
  );
  for (const stage of ['arrive', 'boarded']) r.command('trip', { id: t.id, stage });
  assert.equal(
    r.view().scenario.householdStatuses.find((s) => s.householdId === 'H012')!.status,
    'e119',
  );
  r.command('trip', { id: t.id, stage: 'shelter' });
  assert.equal(
    r.view().scenario.householdStatuses.find((s) => s.householdId === 'H012')!.status,
    'rescued',
  );
});
test('reopening a road keeps a trip held until an officer approves recovery without booking twice', () => {
  const r = ready(),
    t = r.command('dispatch', { id: 'H041', vehicleId: 'V07' }).trips[0],
    road = t.legs.pickup.roadIds[0];
  r.command('road-control', { id: road, blocked: true, revision: r.view().revision });
  const position = tripPosition(r.view().trips[0], r.view().simMinutes);
  r.command('advance');
  r.command('advance');
  assert.throws(
    () => r.command('trip-resume', { id: t.id, revision: r.view().revision }),
    /아직 통제/,
  );
  r.command('road-control', { id: road, blocked: false, revision: r.view().revision });
  assert.ok(r.view().trips[0].heldReason);
  const resumed = r.command('trip-resume', { id: t.id, revision: r.view().revision });
  assert.equal(resumed.trips.length, 1);
  assert.equal(resumed.trips[0].heldReason, null);
  assert.deepEqual(tripPosition(resumed.trips[0], resumed.simMinutes), position);
  assert.equal(resumed.trips[0].departSim, t.departSim + 2);
  assert.ok(resumed.records.some((x) => x.actorType === 'human' && x.label.includes('복구 승인')));
});
test('changed transport needs hold the timeline as a recorded state instead of partially failing advance', () => {
  const r = ready();
  r.command('dispatch', { id: 'H041', vehicleId: 'V07' });
  r.command('edit', { id: 'H041', mobility: '와상', revision: r.view().revision });
  for (let i = 0; i < 8; i++) r.command('advance');
  assert.equal(r.view().trips.length, 1);
  assert.match(r.view().trips[0].heldReason!, /장비/);
  assert.notEqual(
    r.view().scenario.householdStatuses.find((s) => s.householdId === 'H041')!.status,
    'rescued',
  );
});
test('a bedridden companion requires a stretcher and confirmed shelter access', () => {
  const r = ready();
  r.command('companion', {
    id: 'H041',
    label: '가상 동반자',
    mobility: '와상',
    revision: r.view().revision,
  });
  assert.throws(() => r.command('dispatch', { id: 'H041', vehicleId: 'V07' }), /장비/);
  const t = r.command('dispatch', { id: 'H041', vehicleId: 'V02' }).trips[0];
  assert.equal(t.passengerCount, 2);
  assert.equal(t.boardSim - t.arriveSim, 6);
});
