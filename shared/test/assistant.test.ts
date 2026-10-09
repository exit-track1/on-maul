import test from 'node:test';
import assert from 'node:assert/strict';
import { DATA } from '../src/data.ts';
import { groupOf } from '../src/domain.ts';
import { DomainError, Runtime } from '../src/runtime.ts';

function ask(runtime: Runtime, text: string, revision?: number) {
  return runtime.command('assistant', { text, ...(revision === undefined ? {} : { revision }) });
}

function operational(runtime: Runtime) {
  const view = runtime.view();
  view.assistantAnswer = '';
  return view;
}

function review() {
  const runtime = new Runtime();
  runtime.command('scenario', { id: 'review' });
  return runtime;
}

function dispatchReady() {
  const data = structuredClone(DATA);
  data.map.ignition = { x: 0, y: 0 };
  data.map.wind = { direction: 270, speedMps: 0 };
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
  // A synthetic completed-call snapshot isolates resource reporting from call timing.
  for (const call of snapshot.calls) call.phase = 'finished';
  for (const status of snapshot.scenario.householdStatuses)
    status.status = data.households.find((h) => h.id === status.householdId)!.callEligible
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

test('each zone query lists only current action and unfinished visit households', () => {
  const runtime = new Runtime();
  runtime.command('scenario', { id: 'active' });
  runtime.command('visit-complete', { id: 'H027' });
  runtime.command('family', { id: 'H002', status: '입원' });
  for (const [label, zoneId] of [
    ['북', 'N'],
    ['동', 'E'],
    ['남', 'S'],
    ['서', 'W'],
  ]) {
    const before = operational(runtime);
    const expectedIds = before.data.households
      .filter((household) => {
        const status = before.scenario.householdStatuses.find(
          (s) => s.householdId === household.id,
        )!;
        const group = groupOf(household, status);
        return (
          household.zoneId === zoneId &&
          (group === 'act' || (group === 'visit' && !status.visitCompleted))
        );
      })
      .map((household) => household.id)
      .sort();
    const answer = ask(runtime, `${label} 구역 현황`).assistantAnswer;
    assert.match(answer, new RegExp(`^${label} 구역 조치 필요`));
    assert.deepEqual((answer.match(/H\d{3}/g) ?? []).sort(), expectedIds);
    assert.deepEqual(operational(runtime), before);
  }
});

test('remaining households use the current telephone denominator, unfinished visits and exclusions', () => {
  const runtime = new Runtime();
  runtime.command('scenario', { id: 'active' });
  runtime.command('family', { id: 'H002', status: '입원' });
  runtime.command('visit-complete', { id: 'H027' });
  assert.equal(
    ask(runtime, '몇 집 남았나').assistantAnswer,
    '전화 대상 41가구와 미완료 방문 2가구가 남았습니다. 임시 제외 1가구는 별도입니다.',
  );
  runtime.command('edit', { id: 'H012', consent: false, revision: runtime.view().revision });
  assert.equal(
    ask(runtime, '현황').assistantAnswer,
    '전화 대상 40가구와 미완료 방문 3가구가 남았습니다. 임시 제외 1가구는 별도입니다.',
  );
});

test('resource status takes precedence over household status and uses current fleet and responses', () => {
  const data = structuredClone(DATA);
  data.vehicles.find((vehicle) => vehicle.id === 'V09')!.availableForTransport = false;
  data.teams.find((team) => team.id === 'TS')!.members.pop();
  const runtime = new Runtime(data);
  const before = operational(runtime);
  const answer = ask(runtime, '자원 현황').assistantAnswer;
  assert.match(answer, /^수송 자원 8개·진화 전용 1개/);
  assert.match(answer, /차량 대기 8개·출동 0개·수송 중 0개·복귀 중 0개·사용 불가 2개/);
  assert.match(answer, /가능 응답 0\/11명·응답 대기 11명·불가 응답 0명/);
  assert.match(answer, /미예약 가능 0명\. 현재 예약 0건/);
  assert.doesNotMatch(answer, /전화 대상/);
  assert.deepEqual(operational(runtime), before);
});

test('live trip and mirrored resource reserve one vehicle and crew until its return', () => {
  const runtime = dispatchReady();
  assert.match(ask(runtime, '자원 현황').assistantAnswer, /미예약 가능 9명\. 현재 예약 0건/);
  const trip = runtime.command('dispatch', { id: 'H041', vehicleId: 'V07' }).trips[0];
  assert.ok(trip);
  assert.match(
    ask(runtime, '자원 현황').assistantAnswer,
    /차량 대기 8개·출동 1개·수송 중 0개·복귀 중 0개·사용 불가 1개/,
  );
  assert.match(ask(runtime, '자원 현황').assistantAnswer, /미예약 가능 7명\. 현재 예약 1건/);
  runtime.command('trip', { id: trip.id, stage: 'arrive' });
  runtime.command('trip', { id: trip.id, stage: 'boarded' });
  assert.match(ask(runtime, '자원 현황').assistantAnswer, /출동 0개·수송 중 1개·복귀 중 0개/);
  runtime.command('trip', { id: trip.id, stage: 'shelter' });
  assert.match(ask(runtime, '자원 현황').assistantAnswer, /수송 중 0개·복귀 중 1개/);
  assert.match(ask(runtime, '자원 현황').assistantAnswer, /미예약 가능 7명\. 현재 예약 1건/);
  runtime.command('trip', { id: trip.id, stage: 'return' });
  const answer = ask(runtime, '자원 현황').assistantAnswer;
  assert.match(answer, /차량 대기 9개·출동 0개·수송 중 0개·복귀 중 0개/);
  assert.match(answer, /미예약 가능 9명\. 현재 예약 0건/);
});

test('seeded occupied and unavailable resources and changed member responses are reflected', () => {
  const runtime = dispatchReady();
  const snapshot = runtime.view();
  for (const [vehicleId, status] of [
    ['V01', 'enroute'],
    ['V02', 'transporting'],
    ['V03', 'returning'],
    ['V04', 'busy'],
    ['V05', 'unavailable'],
  ])
    snapshot.scenario.resourceStatuses.find(
      (resource) => resource.vehicleId === vehicleId,
    )!.status = status;
  snapshot.memberResponses.M10 = 'waiting';
  snapshot.memberResponses.M11 = 'no';
  runtime.restore(snapshot);
  runtime.command('comms', { down: false });
  const answer = ask(runtime, '자원 현황').assistantAnswer;
  assert.match(answer, /차량 대기 4개·출동 1개·수송 중 1개·복귀 중 1개·사용 불가 3개/);
  assert.match(answer, /가능 응답 7\/12명·응답 대기 1명·불가 응답 4명/);
  assert.match(answer, /미예약 가능 3명\. 현재 예약 4건/);
});

test('explicit first-priority command shares reorder revision guards and human record without confirming', () => {
  const runtime = review();
  const before = runtime.view();
  assert.throws(
    () => ask(runtime, '12번 가구 1순위'),
    (error) => error instanceof DomainError && error.code === 'stale_revision',
  );
  assert.deepEqual(runtime.view(), before);
  assert.throws(
    () => ask(runtime, '12번 가구 1순위', before.revision - 1),
    (error) => error instanceof DomainError && error.code === 'stale_revision',
  );
  assert.deepEqual(runtime.view(), before);
  const updated = ask(runtime, '12번 가구 1순위로', before.revision);
  assert.equal(updated.plan!.order[0].householdId, 'H012');
  assert.deepEqual(
    updated.plan!.order.map((item) => item.rank),
    Array.from({ length: updated.plan!.order.length }, (_, index) => index + 1),
  );
  assert.deepEqual(
    updated.plan!.order.map((item) => item.householdId).sort(),
    before.plan!.order.map((item) => item.householdId).sort(),
  );
  assert.equal(updated.plan!.revision, before.plan!.revision + 1);
  assert.equal(updated.revision, before.revision + 1);
  assert.equal(updated.plan!.snapshotRevision, updated.revision);
  assert.equal(updated.plan!.confirmed, false);
  assert.equal(updated.calls.length, 0);
  assert.equal(updated.records.length, before.records.length + 1);
  assert.equal(updated.records.at(-1)!.actorType, 'human');
  assert.match(updated.records.at(-1)!.label, /순서 수정/);
  assert.match(updated.assistantAnswer, /H012를 1순위로 수정/);
  assert.throws(
    () => runtime.command('confirm', { revision: before.revision }),
    (error) => error instanceof DomainError && error.code === 'stale_revision',
  );
});

test('invalid, visit-only, excluded and confirmed-plan priorities leave operational state unchanged', () => {
  const runtime = review();
  for (const text of ['0번 가구 1순위', '999번 가구 1순위', '4번 가구 1순위']) {
    const before = operational(runtime);
    assert.match(
      ask(runtime, text, before.revision).assistantAnswer,
      /미확정 계획의 유효한 전화 대상/,
    );
    assert.deepEqual(operational(runtime), before);
  }
  runtime.command('family', { id: 'H012', status: '입원' });
  let before = operational(runtime);
  assert.match(
    ask(runtime, '12번 가구 1순위', before.revision).assistantAnswer,
    /유효한 전화 대상/,
  );
  assert.deepEqual(operational(runtime), before);
  runtime.command('family', { id: 'H012', status: '복귀' });
  runtime.command('confirm', { revision: runtime.view().revision });
  before = operational(runtime);
  assert.match(ask(runtime, '12번 가구 1순위', before.revision).assistantAnswer, /확정 후/);
  assert.deepEqual(operational(runtime), before);
  const noPlan = new Runtime();
  before = operational(noPlan);
  assert.match(ask(noPlan, '12번 가구 1순위', before.revision).assistantAnswer, /미확정 계획/);
  assert.deepEqual(operational(noPlan), before);
});

test('explicit outage and restoration reuse communication commands and record human decisions', () => {
  const runtime = review();
  runtime.command('confirm', { revision: runtime.view().revision });
  const before = runtime.view();
  const down = ask(runtime, '통신 두절');
  assert.equal(down.networkDown, true);
  assert.deepEqual(down.calls, before.calls);
  assert.deepEqual(down.trips, before.trips);
  assert.equal(down.revision, before.revision + 1);
  assert.equal(down.records.length, before.records.length + 1);
  assert.equal(down.records.at(-1)!.actorType, 'human');
  assert.match(down.records.at(-1)!.label, /통신 두절/);
  assert.match(down.assistantAnswer, /신규 실행을 보류/);
  runtime.command('transcript', { id: 'H012', text: '숨쉬기 힘들어요' });
  assert.equal(
    runtime.view().handoffs.find((handoff) => handoff.householdId === 'H012')!.status,
    'local',
  );
  const restored = ask(runtime, '통신 복구 시연');
  assert.equal(restored.networkDown, false);
  assert.equal(
    restored.handoffs.find((handoff) => handoff.householdId === 'H012')!.status,
    'mockRecorded',
  );
  assert.equal(restored.records.at(-1)!.actorType, 'human');
  assert.match(restored.records.at(-1)!.label, /통신 복구/);
  const repeated = ask(runtime, '통신 복구');
  assert.deepEqual(repeated.calls, restored.calls);
  assert.deepEqual(repeated.handoffs, restored.handoffs);
});

test('questions, negation, reported speech, compound and unsupported commands cannot authorize actions', () => {
  const runtime = review();
  const commands = [
    '통신 두절인가요?',
    '통신 두절하지 마',
    '통신 복구할까요?',
    '통신 두절 예정',
    '통신 두절 후 복구',
    '통신 두절이라고 들었어요',
    '12번 가구 1순위인가요?',
    '12번 가구를 1순위로 하지 마',
    '12번 가구는 1순위가 아니에요',
    '12번 가구 1순위로 바꿀까요?',
    '12번 가구 1순위. 확정해줘',
    '발령 확정',
    '이장 연결',
    '재배정 승인',
    '북 구역 동 구역',
    '알 수 없는 명령',
  ];
  for (const text of commands) {
    const before = operational(runtime);
    assert.match(ask(runtime, text, before.revision).assistantAnswer, /담당자 결정 버튼/);
    assert.deepEqual(operational(runtime), before, text);
  }
  runtime.command('comms', { down: true });
  const before = operational(runtime);
  assert.match(ask(runtime, '통신 복구하지 마').assistantAnswer, /담당자 결정 버튼/);
  assert.deepEqual(operational(runtime), before);
});

test('invalid assistant input preserves state and closed snapshots reject assistant actions', () => {
  const runtime = review();
  const before = runtime.view();
  for (const text of ['', ' ', 'a'.repeat(501)]) {
    assert.throws(
      () => ask(runtime, text),
      (error) => error instanceof DomainError && error.code === 'invalid_input',
    );
    assert.deepEqual(runtime.view(), before);
  }
  const closed = runtime.command('close', { acknowledged: true });
  assert.throws(() => ask(runtime, '통신 두절'), /종료 스냅샷/);
  assert.deepEqual(runtime.view(), closed);
});
