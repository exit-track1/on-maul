import test from 'node:test';
import assert from 'node:assert/strict';
import { DATA } from '../src/data.ts';
import { Runtime } from '../src/runtime.ts';
import { groupOf, handover } from '../src/domain.ts';

function confirmed() {
  const r = new Runtime();
  r.command('watch');
  r.command('plan');
  r.command('confirm', { revision: r.view().revision });
  return r;
}
function quiet() {
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
  const v = r.view();
  v.calls.forEach((c) => {
    c.phase = 'finished';
    c.outcome = 'answered';
    c.finishedSim = 0;
  });
  v.scenario.householdStatuses.forEach((s) => {
    s.status = data.households.find((h) => h.id === s.householdId)!.callEligible ? 'help' : 'visit';
  });
  v.memberResponses = Object.fromEntries(
    data.teams.flatMap((t) =>
      t.members.map((m) => [m.id, m.availability === '가능' ? ('ok' as const) : ('no' as const)]),
    ),
  );
  r.restore(v);
  r.command('comms', { down: false });
  return r;
}
test('moving creates one shared-channel callback at 15 minutes and overdue remains action required', () => {
  const r = quiet();
  let v = r.command('transcript', { id: 'H001', text: '지금 이동 중이에요', eventId: 'moving-1' });
  const callback = v.calls.find((c) => c.targetId === 'H001' && c.phase === 'queued')!;
  assert.equal(callback.purpose, 'arrival_check');
  assert.equal(callback.nextAt, 15);
  assert.equal(
    r.command('transcript', { id: 'H001', text: '지금 이동 중이에요', eventId: 'moving-1' }).calls
      .length,
    v.calls.length,
  );
  for (let i = 0; i < 14; i++) v = r.command('advance');
  assert.equal(v.calls.find((c) => c.id === callback.id)!.phase, 'queued');
  v = r.command('advance');
  const s = v.scenario.householdStatuses.find((s) => s.householdId === 'H001')!;
  assert.equal(v.calls.find((c) => c.id === callback.id)!.phase, 'calling');
  assert.equal(s.recheckOverdue, true);
  assert.equal(
    groupOf(
      v.data.households.find((h) => h.id === 'H001')!,
      s,
    ),
    'act',
  );
  assert.ok(handover(v.data.households, v.scenario).some((h) => h.household.id === 'H001'));
});
test('unclear schedules five minutes; replacing reservation cancels old slot without double dial', () => {
  const r = quiet();
  let v = r.command('transcript', { id: 'H005', text: '네', eventId: 'unclear' });
  const old = v.calls.find((c) => c.targetId === 'H005' && c.phase === 'queued')!;
  assert.equal(old.nextAt, 5);
  assert.equal(old.purpose, 'clarification');
  v = r.command('schedule-callback', { id: 'H005', minutes: 2, revision: v.revision });
  assert.equal(v.calls.find((c) => c.id === old.id)!.outcome, 'replaced');
  assert.equal(v.calls.filter((c) => c.targetId === 'H005' && c.phase === 'queued').length, 1);
  assert.throws(
    () => r.command('schedule-callback', { id: 'H005', minutes: 0, revision: v.revision }),
    /1~60/,
  );
  r.command('advance');
  v = r.command('advance');
  assert.equal(v.calls.filter((c) => c.targetId === 'H005' && c.phase === 'calling').length, 1);
});
test('arrival, consent revocation, exclusion and emergency cancel old callbacks and late evidence cannot reopen safety', () => {
  for (const action of ['arrival', 'consent', 'exclusion', 'emergency']) {
    const r = quiet();
    let v = r.command('transcript', { id: 'H001', text: '지금 이동 중이에요', eventId: 'start' });
    if (action === 'arrival')
      v = r.command('transcript', { id: 'H001', text: '학교에 도착했어요', eventId: 'done' });
    if (action === 'consent')
      v = r.command('edit', { id: 'H001', consent: false, revision: v.revision });
    if (action === 'exclusion') v = r.command('family', { id: 'H001', status: '입원' });
    if (action === 'emergency')
      v = r.command('transcript', { id: 'H001', text: '숨쉬기 힘들어요', eventId: 'emergency' });
    assert.equal(v.calls.filter((c) => c.targetId === 'H001' && c.phase === 'queued').length, 0);
    assert.equal(
      v.scenario.householdStatuses.find((s) => s.householdId === 'H001')!.callbackAtSim,
      null,
    );
    if (action === 'arrival') {
      v = r.command('transcript', { id: 'H001', text: '지금 이동 중이에요', eventId: 'late' });
      assert.equal(
        v.scenario.householdStatuses.find((s) => s.householdId === 'H001')!.status,
        'safe',
      );
      assert.equal(v.calls.filter((c) => c.phase === 'queued').length, 0);
    }
  }
});
test('member no answer makes exactly two one-minute recalls and keeps single active target', () => {
  const r = confirmed();
  const first = r.view().calls.find((c) => c.targetId === 'M01')!;
  let v = r.command('member-response', { callId: first.id, outcome: 'noanswer' });
  assert.equal(v.memberResponses.M01, 'waiting');
  for (let i = 0; i < 12 && v.memberResponses.M01 === 'waiting'; i++) {
    v = r.command('advance');
    assert.ok(v.calls.filter((c) => ['calling', 'pendingunknown'].includes(c.phase)).length <= 8);
    assert.ok(v.calls.filter((c) => c.targetId === 'M01' && c.phase === 'calling').length <= 1);
  }
  const attempts = v.calls.filter((c) => c.targetId === 'M01');
  assert.equal(v.memberResponses.M01, 'no');
  assert.equal(attempts.length, 3);
  assert.deepEqual(
    attempts.map((c) => c.retryCount),
    [0, 1, 2],
  );
  assert.equal(attempts[1].nextAt! - attempts[0].finishedSim!, 1);
  assert.equal(attempts[2].nextAt! - attempts[1].finishedSim!, 1);
  assert.throws(
    () => r.command('member-response', { callId: first.id, outcome: 'available' }),
    /현재 모의/,
  );
});
test('unavailable team produces reviewed adjacent candidates without reserving or dispatching before approval', () => {
  const r = quiet(),
    v = r.view();
  v.memberResponses.M01 = 'waiting';
  v.memberResponses.M02 = 'no';
  v.memberResponses.M03 = 'no';
  const first = v.calls.find((c) => c.targetId === 'M01')!;
  first.phase = 'calling';
  first.outcome = undefined;
  r.restore(v);
  r.command('comms', { down: false });
  const proposed = r.command('member-response', { callId: first.id, outcome: 'unavailable' });
  assert.ok(proposed.reassignments.length > 0);
  assert.equal(proposed.trips.length, 0);
  assert.ok(proposed.reassignments.every((p) => p.status === 'pending' && p.fromTeamId === 'TW'));
  assert.ok(proposed.reassignments[0].candidates.some((c) => c.vehicleId));
  const count = proposed.reassignments.length;
  assert.equal(r.command('advance').reassignments.length, count);
});
test('resident retry waits 0,1,2,3 minutes, caps additional tries at eight and records SMS once', () => {
  const r = confirmed();
  let v = r.view();
  for (let i = 0; i < 55; i++) v = r.command('advance');
  const calls = v.calls.filter((c) => c.targetId === 'H007');
  assert.equal(calls.length, 9);
  assert.equal(calls.at(-1)!.phase, 'finished');
  assert.deepEqual(
    calls.slice(1).map((c, i) => c.nextAt! - calls[i].finishedSim!),
    [0, 1, 2, 3, 3, 3, 3, 3],
  );
  assert.equal(
    v.records.filter((r) => r.householdId === 'H007' && r.label.startsWith('문자 발송 기록'))
      .length,
    1,
  );
  assert.match(
    v.scenario.householdStatuses.find((s) => s.householdId === 'H007')!.note,
    /추가 8회/,
  );
  assert.ok(handover(v.data.households, v.scenario).some((x) => x.household.id === 'H007'));
});
test('first pass summary is immutable once, preserves callbacks and does not imply safety', () => {
  const r = confirmed();
  let v = r.view();
  for (let i = 0; i < 20 && !v.firstPass; i++) v = r.command('advance');
  assert.equal(v.firstPass?.targets.length, 45);
  assert.equal(v.firstPass?.liveDurationSeconds, null);
  assert.ok(v.calls.some((c) => c.phase === 'queued' && c.purpose !== 'initial'));
  assert.ok(v.scenario.counts.safe < 45);
  const summary = structuredClone(v.firstPass);
  for (let i = 0; i < 10; i++) v = r.command('advance');
  assert.deepEqual(v.firstPass, summary);
  assert.equal(v.records.filter((r) => r.label.startsWith('1차 모의 확인 요약')).length, 1);
});
test('pending unknown counts as a first result but retains provider slot and never triggers synthetic retry', () => {
  const r = quiet(),
    v = r.view();
  v.firstPass = null;
  const call = v.calls.find((c) => c.targetId === 'H012')!;
  call.mode = 'telnyx';
  call.phase = 'pendingunknown';
  call.providerId = 'existing';
  call.outcome = 'pendingunknown';
  r.restore(v);
  let next = r.command('comms', { down: false });
  assert.equal(next.firstPass!.targets.filter((t) => t.outcome === 'pendingunknown').length, 1);
  for (let i = 0; i < 20; i++) next = r.command('advance');
  assert.equal(next.calls.filter((c) => c.targetId === 'H012').length, 1);
  assert.equal(next.calls.find((c) => c.id === call.id)!.providerId, 'existing');
  assert.equal(next.calls.find((c) => c.id === call.id)!.phase, 'pendingunknown');
});
test('live transcript is evidence, never phone-network termination or a synthetic callback', () => {
  const r = quiet();
  r.reserveLive('H001', 'resident', 'live-transcript', r.view().revision);
  r.settleLive('live-transcript', 'provider-original', 'initiated');
  let v = r.command('transcript', {
    id: 'H001',
    text: '지금 이동 중이에요',
    eventId: 'live-moving',
  });
  assert.equal(v.calls.find((c) => c.id === 'live-transcript')!.phase, 'calling');
  assert.equal(v.calls.find((c) => c.id === 'live-transcript')!.providerId, 'provider-original');
  assert.equal(v.calls.filter((c) => c.targetId === 'H001' && c.phase === 'queued').length, 0);
  assert.throws(() => r.reserveLive('H001', 'resident', 'duplicate', v.revision));
  r.finishLive('live-transcript');
  v = r.view();
  assert.equal(v.calls.find((c) => c.id === 'live-transcript')!.phase, 'finished');
});
test('an officer rejection is not overwritten by repeated automatic unavailable-team proposals', () => {
  const r = quiet(),
    v = r.view();
  v.memberResponses.M01 = 'waiting';
  v.memberResponses.M02 = 'no';
  v.memberResponses.M03 = 'no';
  const call = v.calls.find((c) => c.targetId === 'M01')!;
  call.phase = 'calling';
  call.outcome = undefined;
  r.restore(v);
  r.command('comms', { down: false });
  let next = r.command('member-response', { callId: call.id, outcome: 'unavailable' });
  const p = next.reassignments[0];
  next = r.command('reassign-reject', { id: p.id, revision: next.revision });
  const count = next.reassignments.length;
  next = r.command('advance');
  assert.equal(next.reassignments.length, count);
  assert.equal(next.reassignments.find((x) => x.id === p.id)!.status, 'rejected');
});
