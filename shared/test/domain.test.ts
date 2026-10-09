import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DATA } from '../src/data.ts';
import { eta, groupOf, handover, staleReason, tally, vulnerability } from '../src/domain.ts';
import { classify } from '../src/classification.ts';
import { Runtime } from '../src/runtime.ts';
const shelters = DATA.shelters.map((s) => s.name);
test('synthetic fixture counts, IDs, contact policy and all relationships', () => {
  assert.equal(DATA.metadata.synthetic, true);
  assert.equal(DATA.households.length, 48);
  assert.equal(DATA.households.filter((h) => h.callEligible).length, 45);
  assert.equal(DATA.households.filter((h) => !h.consentToCall).length, 2);
  assert.equal(DATA.households.filter((h) => h.phoneKind === '없음').length, 1);
  assert.equal(DATA.households.filter((h) => h.priorityGrade === 4).length, 3);
  assert.equal(DATA.households.filter((h) => h.priorityGrade === 3).length, 12);
  assert.equal(DATA.teams.length, 4);
  assert.equal(DATA.teams.flatMap((t) => t.members).length, 12);
  assert.equal(
    DATA.teams.flatMap((t) => t.members).filter((m) => m.availability === '가능').length,
    9,
  );
  assert.equal(DATA.vehicles.length, 10);
  assert.equal(DATA.vehicles.filter((v) => v.availableForTransport).length, 9);
  assert.equal(DATA.sources.length, 8);
  assert.equal(DATA.shelters.length, 3);
  assert.equal(DATA.responseCases.length, 14);
  for (const key of [
    'households',
    'teams',
    'vehicles',
    'sources',
    'shelters',
    'zones',
    'responseCases',
    'scenarios',
    'eventLogs',
    'checkLogs',
    'callTranscripts',
  ] as const) {
    const records = DATA[key];
    assert.equal(new Set(records.map((x) => x.id)).size, records.length);
    assert.deepEqual(
      JSON.parse(readFileSync(new URL(`../../fixtures/${key}.json`, import.meta.url), 'utf8')),
      records,
    );
  }
  for (const z of DATA.zones)
    assert.equal(DATA.households.filter((h) => h.zoneId === z.id).length, z.householdCount);
  const positions = new Set<string>();
  for (const h of DATA.households) {
    const z = DATA.zones.find((z) => z.id === h.zoneId)!;
    assert.ok(z);
    assert.ok(DATA.shelters.some((s) => s.id === h.shelterId));
    assert.ok(DATA.teams.find((t) => t.id === h.teamId)?.assignedHouseholdIds.includes(h.id));
    assert.equal(h.priorityGrade, vulnerability(h));
    assert.match(h.addressLabel, /^DEMO-/);
    if (h.contactRef) assert.match(h.contactRef, /^DEMO-CONTACT-/);
    if (h.guardian) assert.match(h.guardian.contactRef, /^DEMO-CONTACT-/);
    const { x, y } = h.demoPosition;
    assert.ok(
      x >= z.demoBounds.x1 && x <= z.demoBounds.x2 && y >= z.demoBounds.y1 && y <= z.demoBounds.y2,
    );
    positions.add(`${x},${y}`);
  }
  assert.equal(positions.size, 48);
  for (const t of DATA.teams) {
    assert.ok(DATA.vehicles.some((v) => v.id === t.vehicleId));
    assert.ok(t.members.some((m) => m.canDrive && m.availability === '가능'));
    for (const id of t.assignedHouseholdIds)
      assert.equal(DATA.households.find((h) => h.id === id)?.teamId, t.id);
  }
  for (const v of DATA.vehicles) {
    assert.match(v.plateLabel, /^DEMO-VEHICLE-/);
    assert.ok(DATA.teams.flatMap((t) => t.members).some((m) => m.id === v.driverRef));
  }
  for (const s of DATA.scenarios) {
    assert.equal(s.householdStatuses.length, 48);
    assert.deepEqual(tally(DATA.households, s.householdStatuses), s.counts);
    assert.equal(s.counts.eligible + s.counts.visit + s.counts.temporarilyExcluded, 48);
    if (s.counts.before === 0) assert.equal(s.counts.act + s.counts.prog + s.counts.safe, 45);
    for (const id of s.pendingReviewIds)
      assert.ok(
        s.householdStatuses.some(
          (h) => h.householdId === id && ['e119', 'refuse', 'visiting'].includes(h.status),
        ),
      );
    const drivers = s.resourceStatuses
      .filter((v) => v.status === 'enroute')
      .map((v) => DATA.vehicles.find((x) => x.id === v.vehicleId)!.driverRef);
    assert.equal(new Set(drivers).size, drivers.length);
  }
  for (const r of DATA.eventLogs) {
    const s = DATA.scenarios.find((s) => s.id === r.scenarioId)!;
    assert.ok(s);
    assert.ok(Date.parse(r.timestamp) <= Date.parse(s.displayTime));
    if (r.householdId) assert.ok(DATA.households.some((h) => h.id === r.householdId));
    if (r.teamId) assert.ok(DATA.teams.some((t) => t.id === r.teamId));
    if (r.vehicleId) assert.ok(DATA.vehicles.some((v) => v.id === r.vehicleId));
  }
  for (const t of DATA.callTranscripts) {
    assert.ok(DATA.scenarios.some((s) => s.id === t.scenarioId));
    assert.ok(DATA.households.some((h) => h.id === t.householdId));
    assert.equal(t.synthetic, true);
    assert.deepEqual(
      t.turns.map((t) => t.sequence),
      [1, 2],
    );
  }
  for (const l of DATA.checkLogs) {
    assert.ok(DATA.households.some((h) => h.id === l.householdId));
    assert.ok(
      Date.parse(l.checkedAt) <= Date.parse(DATA.metadata.referenceDate + 'T23:59:59+09:00'),
    );
  }
});
test('90-day boundary, missing, invalid and future dates are distinct', () => {
  assert.equal(staleReason('2026-07-11', '2026-10-09'), null);
  assert.match(staleReason('2026-07-10', '2026-10-09')!, /90일/);
  assert.equal(staleReason(null, '2026-10-09'), '확인일 없음');
  assert.equal(staleReason('2026-02-30', '2026-10-09'), '확인일 오류');
  assert.equal(staleReason('2026-10-10', '2026-10-09'), '미래 확인일 오류');
  assert.equal(
    DATA.households.filter((h) => staleReason(h.lastCheckedAt, DATA.metadata.referenceDate)).length,
    3,
  );
});
test('ETA upwind is positive, lateral symmetric, invalid wind is unknown', () => {
  const g = { x: 0, y: 0 };
  assert.ok(eta({ x: 0, y: -100 }, g, 0, 9)! > 0);
  assert.ok(Math.abs(eta({ x: 20, y: 100 }, g, 0, 9)! - eta({ x: -20, y: 100 }, g, 0, 9)!) < 1e-10);
  assert.equal(eta({ x: 1, y: 1 }, g, 0, NaN), null);
  assert.equal(eta({ x: 1, y: 1 }, g, 0, -1), null);
});
test('plain yes, future arrival, negated arrival and reported speech never prove safety', () => {
  for (const text of [
    '네',
    '학교에 도착할 거예요',
    '학교에 아직 도착하지 못했어요',
    '학교에 도착했나요?',
    '학교에 도착했다고 들었어요',
  ])
    assert.notEqual(classify(text, shelters).status, 'safe');
  assert.equal(classify('학교에 도착했어요', shelters).status, 'safe');
  assert.equal(classify('지금 이동 중이에요', shelters).status, 'moving');
  assert.equal(classify('대피소로 가겠습니다', shelters).acked, true);
  assert.equal(classify('네', shelters).acked, false);
});
test('emergency evidence overrides completion but symptom negation is not emergency', () => {
  assert.equal(classify('학교에 도착했어요. 숨쉬기 힘들어요', shelters).status, 'e119');
  assert.notEqual(classify('숨이 안 차요', shelters).status, 'e119');
});
test('event confirmation is revision guarded, idempotent and uses 8 shared fair channels', () => {
  const r = new Runtime();
  r.command('watch');
  assert.equal(r.view().calls.length, 0);
  r.command('plan');
  assert.equal(r.view().calls.length, 0);
  const rev = r.view().revision;
  assert.throws(() => r.command('confirm', { revision: rev - 1 }), /상태가 변경/);
  const v = r.command('confirm', { revision: rev });
  assert.equal(v.calls.length, 57);
  const active = v.calls.filter((c) => c.phase === 'calling');
  assert.equal(active.length, 8);
  assert.deepEqual(
    active.toSorted((a, b) => a.startedOrder! - b.startedOrder!).map((c) => c.targetType),
    ['resident', 'member', 'resident', 'member', 'resident', 'member', 'resident', 'member'],
  );
  assert.equal(new Set(active.map((c) => c.targetId)).size, 8);
  assert.deepEqual(r.command('confirm', { revision: rev }), v);
});
test('consent revocation changes denominator atomically without ending an active call', () => {
  const r = new Runtime();
  r.command('scenario', { id: 'active' });
  let v = r.view();
  v = r.command('edit', { id: 'H012', consent: false, revision: v.revision });
  assert.equal(v.scenario.counts.eligible, 44);
  assert.equal(v.scenario.counts.visit, 4);
  assert.equal(v.scenario.counts.act + v.scenario.counts.prog + v.scenario.counts.safe, 44);
});
test('check date changes only on explicit field confirmation', () => {
  const r = new Runtime();
  const before = r.view().data.households.find((h) => h.id === 'H009')!;
  r.command('edit', { id: 'H009', mobility: '자력', revision: r.view().revision });
  assert.equal(
    r.view().data.households.find((h) => h.id === 'H009')!.lastCheckedAt,
    before.lastCheckedAt,
  );
  r.command('check', { id: 'H009', fields: ['mobility'], source: '이장' });
  assert.equal(
    r.view().data.households.find((h) => h.id === 'H009')!.lastCheckedAt,
    DATA.metadata.referenceDate,
  );
});
test('family temporary exclusion is separate from visit and safety', () => {
  const r = new Runtime();
  r.command('scenario', { id: 'active' });
  let v = r.command('family', { id: 'H002', status: '입원' });
  assert.equal(v.scenario.counts.temporarilyExcluded, 1);
  assert.equal(v.scenario.counts.eligible, 44);
  assert.equal(v.scenario.counts.visit, 3);
  assert.equal(v.scenario.counts.safe, 3);
  v = r.command('family', { id: 'H002', status: '복귀' });
  assert.equal(v.scenario.counts.eligible, 45);
});
test('handoff receipt is not safety, duplicate events do not create duplicate receipts', () => {
  const r = new Runtime();
  r.command('scenario', { id: 'active' });
  const v = r.command('transcript', { id: 'H012', text: '숨쉬기 힘들어요', eventId: 'same' });
  assert.equal(v.scenario.householdStatuses.find((s) => s.householdId === 'H012')?.status, 'e119');
  assert.equal(
    r.command('transcript', { id: 'H012', text: '숨쉬기 힘들어요', eventId: 'same' }).handoffs
      .length,
    v.handoffs.length,
  );
  assert.ok(handover(v.data.households, v.scenario).some((x) => x.household.id === 'H012'));
});
test('comms outage preserves active calls, queues emergency locally and recovers once', () => {
  const r = new Runtime();
  r.command('watch');
  r.command('plan');
  r.command('confirm', { revision: r.view().revision });
  const active = r.view().calls.filter((c) => c.phase === 'calling');
  r.command('comms', { down: true });
  assert.deepEqual(
    r.view().calls.filter((c) => c.phase === 'calling'),
    active,
  );
  r.command('transcript', { id: 'H012', text: '숨쉬기 힘들어요' });
  assert.equal(r.view().handoffs[0].status, 'local');
  r.command('comms', { down: false });
  assert.equal(r.view().handoffs[0].status, 'mockRecorded');
  r.command('comms', { down: false });
  assert.equal(r.view().handoffs.length, 1);
});
test('moving and dispatched remain in immutable handover snapshot', () => {
  const r = new Runtime();
  r.command('scenario', { id: 'active' });
  const before = r.view(),
    expected = 45 - before.scenario.counts.safe + 3;
  assert.equal(handover(before.data.households, before.scenario).length, expected);
  const frozen = r.command('close', { acknowledged: true });
  assert.equal(frozen.frozen, true);
  assert.equal(handover(frozen.data.households, frozen.scenario).length, expected);
  assert.throws(() => r.command('advance'), /종료 스냅샷/);
  assert.deepEqual(r.view(), frozen);
});
test('equipment, accessibility and existing reservations block invalid dispatch', () => {
  const r = new Runtime();
  r.command('scenario', { id: 'active' });
  const held = r.command('dispatch', { id: 'H012', vehicleId: 'V04' });
  assert.equal(held.trips.length, 0);
  assert.equal(
    held.scenario.householdStatuses.find((s) => s.householdId === 'H012')?.status,
    'e119',
  );
  const busy = r.command('dispatch', { id: 'H002', vehicleId: 'V01' });
  assert.match(
    busy.scenario.householdStatuses.find((s) => s.householdId === 'H002')?.dispatchHold ?? '',
    /출동/,
  );
  assert.equal(busy.trips.length, 0);
  assert.throws(() => r.command('dispatch', { id: 'H002', vehicleId: 'V10' }), /수송 불가/);
});
test('source failure remains failed after synthetic collect', () => {
  const r = new Runtime();
  r.command('watch');
  r.command('source-fail', { id: 'SRC01' });
  assert.equal(
    r.command('collect').scenario.sourceStatuses.filter((s) => s.status === 'ok').length,
    7,
  );
});

test('restart preserves uncertain provider ID and does not replay dial or pretend safety', () => {
  const r = new Runtime();
  r.command('scenario', { id: 'active' });
  r.reserveLive('H012', 'resident', 'request-recovery', r.view().revision);
  r.settleLive('request-recovery', 'control-recovery', 'initiated');
  const old = r.view(),
    restored = new Runtime();
  restored.restore(old);
  const v = restored.view();
  assert.equal(v.networkDown, true);
  assert.equal(v.calls.find((c) => c.id === 'request-recovery')?.phase, 'pendingunknown');
  assert.equal(v.calls.find((c) => c.id === 'request-recovery')?.providerId, 'control-recovery');
  assert.equal(
    v.scenario.householdStatuses.find((s) => s.householdId === 'H012')?.status,
    'pendingunknown',
  );
  assert.throws(() => restored.reserveLive('H012', 'resident', 'duplicate', v.revision));
  assert.notEqual(v.scenario.counts.safe, 45);
});
test('fabricated emergency result without corresponding quoted evidence is rejected', () => {
  const r = new Runtime();
  r.command('scenario', { id: 'active' });
  assert.throws(
    () =>
      r.applyClassification('H012', {
        status: 'e119',
        acked: false,
        location: null,
        quoted: '네',
        reason: '응급이라고 추정',
        reviewRequired: false,
        executionMode: 'rules',
      }),
    /일치하지/,
  );
});
