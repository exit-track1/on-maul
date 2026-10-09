import test from 'node:test';
import assert from 'node:assert/strict';
import { DATA } from '../src/data.ts';
import { configureDemoStory, type DemoStory } from '../src/demo-story.ts';
import { Runtime } from '../src/runtime.ts';
import { evaluateDispatch } from '../src/dispatch.ts';
import { eta } from '../src/domain.ts';
import { findDemoRoute, routeIsOpen } from '../src/routing.ts';

for (const story of ['grandfather', 'squad'] as const) {
  test(`${story} overlay uses a private synthetic fixture and has no completion or response authority`, () => {
    const original = structuredClone(DATA),
      data = structuredClone(DATA),
      demonstration = configureDemoStory(data, story),
      resident = data.households.find((household) => household.id === demonstration.residentId)!;
    assert.deepEqual(DATA, original);
    assert.equal(demonstration.synthetic, true);
    assert.equal(demonstration.story, story);
    assert.equal(demonstration.stage, 'ready');
    assert.deepEqual(demonstration.messages, []);
    assert.equal(resident.name, story === 'grandfather' ? '반영환 할아버지' : '박미숙 할머니');
    assert.equal(resident.mobility, '보조');
    assert.equal(resident.priorityGrade, 4);
    assert.deepEqual(resident.devices, []);
    assert.equal(resident.shelterId, 'S2');
    assert.equal(
      resident.callEligible,
      original.households.find((household) => household.id === resident.id)!.callEligible,
    );
    assert.equal(
      resident.consentToCall,
      original.households.find((household) => household.id === resident.id)!.consentToCall,
    );
    assert.deepEqual(data.scenarios, original.scenarios);
    assert.deepEqual(data.map.wind, original.map.wind);
    assert.deepEqual(data.sources, original.sources);
    assert.deepEqual(data.map.roads, original.map.roads);
    assert.deepEqual(data.map.ignition, { x: 900, y: 50 });
    assert.ok(data.map.ignition.x <= data.map.width && data.map.ignition.y <= data.map.height);
  });

  test(`${story} overlay supports actual open routes and still requires confirmed transport members`, () => {
    const data = structuredClone(DATA),
      demonstration = configureDemoStory(data, story),
      resident = data.households.find((household) => household.id === demonstration.residentId)!,
      vehicle = data.vehicles.find((vehicle) => vehicle.id === demonstration.vehicleId)!,
      shelter = data.shelters.find((shelter) => shelter.id === resident.shelterId)!,
      origin = vehicle.teamId
        ? data.teams.find((team) => team.id === vehicle.teamId)!.meetingPoint
        : data.map.office;
    for (const [from, to] of [
      [origin, resident.demoPosition],
      [resident.demoPosition, shelter.demoLocation],
      [shelter.demoLocation, origin],
    ]) {
      const route = findDemoRoute(data.map, from, to);
      assert.ok(route);
      assert.equal(routeIsOpen(data.map, route), true);
      assert.ok(route.roadIds.length > 0);
      assert.equal(route.roadIds.includes('ROAD1'), false);
    }
    const runtime = new Runtime(data);
    runtime.command('watch');
    runtime.command('plan');
    const view = runtime.command('confirm', { revision: runtime.view().revision });
    view.scenario.householdStatuses.find((status) => status.householdId === resident.id)!.status =
      'help';
    assert.equal(evaluateDispatch(view, resident.id, vehicle.id).ok, false);
    view.memberResponses[demonstration.memberId!] = 'ok';
    if (story === 'squad') {
      assert.equal(
        evaluateDispatch(view, resident.id, vehicle.id).ok,
        false,
        'one driver alone cannot authorize a squad dispatch',
      );
      view.memberResponses.M03 = 'ok';
      const estimates = data.households
        .filter((household) => household.zoneId === resident.zoneId)
        .map((household) =>
          eta(
            household.demoPosition,
            data.map.ignition,
            data.map.wind.direction,
            data.map.wind.speedMps,
          )!,
        );
      assert.ok(Math.min(...estimates) >= 30);
    }
    const dispatch = evaluateDispatch(view, resident.id, vehicle.id);
    assert.equal(dispatch.ok, true, JSON.stringify(dispatch));
    if (dispatch.ok) {
      assert.equal(dispatch.trip.vehicleId, demonstration.vehicleId);
      assert.equal(dispatch.trip.shelterId, 'S2');
      assert.equal(dispatch.trip.passengerCount, 1);
      assert.ok(dispatch.trip.crewMemberIds!.includes(demonstration.memberId!));
      assert.equal(dispatch.trip.crewMemberIds!.length, story === 'squad' ? 2 : 1);
    }
  });
}

test('invalid story or non-synthetic input is rejected before any fixture mutation', () => {
  for (const story of ['unknown', 'grandfather'] as const) {
    const data = structuredClone(DATA);
    if (story === 'grandfather') data.metadata.synthetic = false;
    const before = structuredClone(data);
    assert.throws(() => configureDemoStory(data, story as DemoStory), TypeError);
    assert.deepEqual(data, before);
  }
});

test('story setup cannot silently mark an unconfirmed shelter accessible or invent a missing crew member', () => {
  for (const invalid of ['shelter', 'member'] as const) {
    const data = structuredClone(DATA);
    if (invalid === 'shelter')
      data.shelters.find((shelter) => shelter.id === 'S2')!.accessibility = 'unknown';
    else
      data.teams.find((team) => team.id === 'TW')!.members = data.teams
        .find((team) => team.id === 'TW')!
        .members.filter((member) => member.id !== 'M03');
    const before = structuredClone(data);
    assert.throws(() => configureDemoStory(data, 'squad'), TypeError);
    assert.deepEqual(data, before);
  }
});
