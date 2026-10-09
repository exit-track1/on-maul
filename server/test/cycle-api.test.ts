import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.ts';
import { config, type TelephonyConfig, type TelnyxPort } from '../src/telephony.ts';
import type { SimulationTimer } from '../src/simulation.ts';
import type { View } from '../../shared/src/runtime.ts';
import type { Demonstration } from '../../shared/src/demo-story.ts';
import { predictionEvidence } from '../../shared/src/monitoring.ts';

class FakeClock implements SimulationTimer {
  milliseconds = 0;
  readonly callbacks = new Map<symbol, () => void>();
  readonly intervals: number[] = [];
  readonly cleared: unknown[] = [];
  now = () => this.milliseconds;
  setInterval(callback: () => void, milliseconds: number) {
    const handle = Symbol('simulation interval');
    this.callbacks.set(handle, callback);
    this.intervals.push(milliseconds);
    return handle;
  }
  clearInterval(handle: unknown) {
    this.cleared.push(handle);
    this.callbacks.delete(handle as symbol);
  }
  elapse(milliseconds: number) {
    this.milliseconds += milliseconds;
  }
  fire(repetitions = 1) {
    for (let i = 0; i < repetitions; i++)
      for (const callback of this.callbacks.values()) callback();
  }
  advance(milliseconds: number, repetitions = 1) {
    this.elapse(milliseconds);
    this.fire(repetitions);
  }
}

type Session = Awaited<ReturnType<typeof createApp>>;
async function fixture(t: TestContext, settings: TelephonyConfig = config({})) {
  const journal = mkdtempSync(join(tmpdir(), 'onmaul-cycle-api-'));
  const clock = new FakeClock();
  let transportCalls = 0;
  const port: TelnyxPort = {
    async dial() {
      transportCalls++;
      throw new Error('Cycle tests cannot dial a telephone.');
    },
    async hangup() {
      transportCalls++;
      throw new Error('Cycle tests cannot use a telephone transport.');
    },
  };
  let session = await createApp({
    settings,
    port,
    journal,
    simulation: { now: clock.now, timer: clock },
  });
  t.after(async () => {
    await session.app.close();
    rmSync(journal, { recursive: true, force: true });
    assert.equal(clock.callbacks.size, 0);
    assert.equal(transportCalls, 0);
  });
  const headers =
    settings.mode === 'hybrid' ? { authorization: `Bearer ${settings.operatorToken}` } : {};
  const f = {
    clock,
    journal,
    current: (): Session => session,
    post: (action: string, input: Record<string, unknown> = {}) =>
      session.app.inject({
        method: 'POST',
        url: '/api/command',
        headers,
        payload: { action, input },
      }),
    sim: (input: Record<string, unknown>) =>
      session.app.inject({ method: 'POST', url: '/api/sim', headers, payload: input }),
    async state(): Promise<View> {
      const response = await session.app.inject('/api/state');
      assert.equal(response.statusCode, 200, response.body);
      return response.json<View>();
    },
    async command(action: string, input: Record<string, unknown> = {}): Promise<View> {
      const response = await f.post(action, input);
      assert.equal(response.statusCode, 200, response.body);
      return response.json<View>();
    },
    async control(input: Record<string, unknown>): Promise<View> {
      const response = await f.sim(input);
      assert.equal(response.statusCode, 200, response.body);
      return response.json<View>();
    },
    async start(): Promise<View> {
      const before = await f.state();
      const review = await f.command('cycle-start', { revision: before.revision });
      return f.command('confirm', { revision: review.revision });
    },
    async restart() {
      await session.app.close();
      session = await createApp({
        settings,
        port,
        journal,
        simulation: { now: clock.now, timer: clock },
      });
    },
    async assertLocalOnly() {
      const health = (await session.app.inject('/api/health')).json();
      assert.equal(health.externalInferenceCalls, 0);
      assert.equal(health.inference, 'rules');
      assert.equal((await f.state()).sourceState.actualModelCalls, 0);
      assert.equal(transportCalls, 0);
    },
  };
  return f;
}

function near(actual: number, expected: number) {
  assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
}

test('cycle API waits for current human review, creates a new matching checkpoint, and starts zero external calls', async (t) => {
  const f = await fixture(t);
  await f.command('watch');
  const previous = await f.command('plan');
  const oldGraph = previous.graphRuns.find((run) => run.waiting)!;
  const review = await f.command('cycle-start', { revision: previous.revision });
  assert.equal(review.simulation.phase, 'review');
  assert.equal(review.simulation.playing, false);
  assert.equal(review.simulation.durationMinutes, 40);
  assert.equal(review.simMinutes, 0);
  assert.equal(review.data.households.length, 48);
  assert.equal(review.calls.length, 0);
  assert.equal(review.plan!.confirmed, false);
  const graph = review.graphRuns.find((run) => run.waiting)!;
  assert.notEqual(graph.id, oldGraph.id);
  assert.equal(
    review.graphRuns.some((run) => run.id === oldGraph.id),
    false,
  );
  const checkpoint = await f
    .current()
    .agents.plan.getState({ configurable: { thread_id: graph.id } });
  assert.equal(checkpoint.values.revision, review.plan!.snapshotRevision);
  assert.deepEqual(checkpoint.values.order, review.plan!.order);
  assert.deepEqual(checkpoint.values.visit, review.plan!.visit);
  f.clock.advance(60000, 10);
  assert.equal((await f.state()).simMinutes, 0);
  assert.equal((await f.post('confirm', { revision: review.revision - 1 })).statusCode, 409);
  assert.equal((await f.state()).calls.length, 0);
  const active = await f.command('confirm', { revision: review.revision });
  assert.equal(active.simulation.phase, 'running');
  assert.equal(active.simulation.playing, true);
  assert.equal(active.graphRuns.find((run) => run.id === graph.id)!.waiting, false);
  const oldCheckpoint = await f
    .current()
    .agents.plan.getState({ configurable: { thread_id: oldGraph.id } });
  assert.equal(oldCheckpoint.values.approved, false);
  assert.ok(active.calls.length > 0);
  assert.ok(active.calls.every((call) => call.mode === 'mock'));
  assert.deepEqual(f.clock.intervals, [250]);
  await f.assertLocalOnly();
});

test('server clock settles the old speed and excludes paused, disconnected, and review wall time', async (t) => {
  const f = await fixture(t);
  let view = await f.start();
  view = await f.control({ revision: view.revision, speed: 12 });
  const beforePulse = view.revision;
  f.clock.advance(500, 20);
  view = await f.state();
  near(view.simMinutes, 0.1);
  assert.equal(
    view.revision,
    beforePulse,
    'clock-only pulses must not starve current human commands',
  );
  view = await f.control({ revision: view.revision, playing: false });
  f.clock.advance(120000);
  near((await f.state()).simMinutes, 0.1);
  view = await f.control({ revision: view.revision, speed: 30, playing: true });
  f.clock.advance(500);
  view = await f.state();
  near(view.simMinutes, 0.35);
  f.clock.elapse(250); // No pulse: changing speed must first account for this at 30x.
  view = await f.control({ revision: view.revision, speed: 60 });
  near(view.simMinutes, 0.475);
  f.clock.advance(500);
  view = await f.state();
  near(view.simMinutes, 0.975);
  view = await f.command('comms', { down: true });
  assert.equal(view.simulation.playing, false);
  f.clock.advance(120000, 10);
  near((await f.state()).simMinutes, 0.975);
  view = await f.command('comms', { down: false });
  assert.equal(view.simulation.playing, false);
  f.clock.advance(120000);
  near((await f.state()).simMinutes, 0.975);
  view = await f.control({ revision: view.revision, playing: true });
  const currentRevision = view.revision;
  f.clock.advance(250);
  view = await f.state();
  near(view.simMinutes, 1.225);
  assert.ok(view.revision > currentRevision, 'meaningful simulated results invalidate old review');
  const stale = await f.sim({ revision: currentRevision, playing: false });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().code, 'stale_revision');
  assert.equal((await f.state()).simulation.playing, true);
  await f.assertLocalOnly();
});

test('duplicate pulses and a backwards clock cannot advance a cycle twice; concurrent controls serialize', async (t) => {
  const f = await fixture(t);
  let view = await f.start();
  view = await f.control({ revision: view.revision, speed: 12 });
  const auditRows = () => readFileSync(join(f.journal, 'events.jsonl'), 'utf8').trim().split('\n');
  const beforePulseEvents = auditRows().length;
  f.clock.advance(500, 100);
  view = await f.state();
  near(view.simMinutes, 0.1);
  assert.equal(auditRows().length, beforePulseEvents);
  assert.deepEqual(JSON.parse(readFileSync(join(f.journal, 'snapshot.json'), 'utf8')), view);
  f.clock.milliseconds -= 100;
  f.clock.fire(10);
  near((await f.state()).simMinutes, 0.1);
  f.clock.advance(200, 100);
  view = await f.state();
  near(view.simMinutes, 0.12);
  const results = await Promise.all([
    f.sim({ revision: view.revision, playing: false }),
    f.post('sim', { revision: view.revision, speed: 30 }),
  ]);
  assert.deepEqual(
    results.map((response) => response.statusCode),
    [200, 409],
  );
  view = await f.state();
  assert.equal(view.simulation.playing, false);
  assert.equal(view.simulation.speed, 12);
  assert.equal(auditRows().length, beforePulseEvents + 1);
  const saved = JSON.parse(readFileSync(join(f.journal, 'snapshot.json'), 'utf8')) as View;
  assert.deepEqual(saved, view);
  await f.assertLocalOnly();
});

test('40-minute cycle preserves manual source failures and unresolved handover, then freezes only on acknowledgement', async (t) => {
  const f = await fixture(t);
  let view = await f.start();
  view = await f.control({ revision: view.revision, speed: 60 });
  view = await f.command('source-fail', { id: 'SRC01' });
  const failure = view.sourceState.records.findLast(
    (record) => record.sourceId === 'SRC01' && !record.ok,
  )!;
  f.clock.advance(39000);
  view = await f.state();
  assert.ok(view.simMinutes <= 39);
  assert.equal(
    view.scenario.sourceStatuses.find((source) => source.sourceId === 'SRC01')!.status,
    'fail',
  );
  assert.ok(view.sourceState.records.some((record) => record.recordId === failure.recordId));
  assert.equal(
    predictionEvidence(view).usable,
    true,
    'synthetic wind observation must remain fresh during playback',
  );
  f.clock.advance(61000, 30);
  view = await f.state();
  assert.equal(view.simulation.phase, 'awaiting_handover');
  assert.equal(view.simulation.playing, false);
  assert.ok(view.simMinutes <= 40);
  assert.equal(view.frozen, false);
  assert.ok(view.simulation.endReason);
  assert.ok(
    view.scenario.householdStatuses.some((status) => !['safe', 'rescued'].includes(status.status)),
  );
  assert.ok(
    view.scenario.householdStatuses.some(
      (status) => status.status === 'visit' && !status.visitCompleted,
    ),
  );
  assert.equal((await f.post('close', { acknowledged: false })).statusCode, 409);
  const ended = await f.command('close', { acknowledged: true });
  assert.equal(ended.simulation.phase, 'ended');
  assert.equal(ended.frozen, true);
  assert.deepEqual(ended.scenario.householdStatuses, view.scenario.householdStatuses);
  f.clock.advance(120000);
  assert.deepEqual(await f.state(), ended);
  assert.equal((await f.sim({ revision: ended.revision, playing: true })).statusCode, 409);
  const exported = (await f.current().app.inject('/api/export.json')).json<View>();
  assert.deepEqual(exported, ended);
  const oldInstance = (await f.current().app.inject('/api/state')).headers['x-onmaul-instance'];
  await f.restart();
  assert.deepEqual(await f.state(), ended);
  assert.notEqual(
    (await f.current().app.inject('/api/state')).headers['x-onmaul-instance'],
    oldInstance,
  );
  f.clock.advance(120000);
  assert.deepEqual(await f.state(), ended);
  await f.assertLocalOnly();
});

test('sim endpoint uses operator authentication, strict inputs, and a per-app CORS-exposed instance header', async (t) => {
  const settings = config({
    ON_EXECUTION_MODE: 'hybrid',
    TELNYX_API_KEY: 'disabled-test-key',
    TELNYX_APPLICATION_ID: 'disabled-test-app',
    CALLER_NUMBER: '+' + '1'.repeat(12),
    PUBLIC_BASE_URL: 'https://example.invalid',
    TELNYX_PUBLIC_KEY: Buffer.alloc(32).toString('base64'),
    ON_OPERATOR_TOKEN: 't'.repeat(32),
  });
  const f = await fixture(t, settings);
  const health = await f.current().app.inject('/api/health');
  const instance = health.headers['x-onmaul-instance'];
  assert.ok(typeof instance === 'string' && instance.length > 0);
  let view = await f.start();
  const unauthorized = await f.current().app.inject({
    method: 'POST',
    url: '/api/sim',
    payload: { revision: view.revision, playing: false },
  });
  assert.equal(unauthorized.statusCode, 401);
  assert.equal(unauthorized.headers['x-onmaul-instance'], instance);
  assert.equal((await f.state()).simulation.playing, true);
  for (const invalid of [
    { revision: view.revision, speed: 24 },
    { revision: view.revision, playing: 'false' },
    { revision: view.revision },
    { revision: view.revision, playing: false, extra: true },
  ])
    assert.equal((await f.sim(invalid)).statusCode, 400);
  view = await f.control({ revision: view.revision, playing: false });
  assert.equal(view.simulation.playing, false);
  const response = await f
    .current()
    .app.inject({ url: '/api/state', headers: { origin: 'http://localhost:5173' } });
  assert.equal(response.headers['x-onmaul-instance'], instance);
  assert.equal(response.headers['access-control-expose-headers'], 'x-onmaul-instance');
  await f.assertLocalOnly();
});

test('closing the app cancels the simulation interval and makes an already captured callback inert', async (t) => {
  const f = await fixture(t);
  let view = await f.start();
  view = await f.control({ revision: view.revision, speed: 12 });
  const callback = [...f.clock.callbacks.values()][0]!;
  f.clock.elapse(250);
  callback();
  await f.current().app.close();
  const closed = f.current().runtime.view();
  assert.equal(f.clock.callbacks.size, 0);
  assert.equal(f.clock.cleared.length, 1);
  f.clock.elapse(120000);
  callback();
  await Promise.resolve();
  assert.deepEqual(f.current().runtime.view(), closed);
});

test('real telephone entry retains current confirmed revision and communication guards during a synthetic cycle', async (t) => {
  const f = await fixture(t);
  const before = await f.state();
  const review = await f.command('cycle-start', { revision: before.revision });
  const dial = (revision: number) =>
    f.current().app.inject({
      method: 'POST',
      url: '/api/telephony/dial',
      payload: { targetId: 'H012', targetType: 'resident', consent: true, revision },
    });
  const unconfirmed = await dial(review.revision);
  assert.equal(unconfirmed.statusCode, 409);
  assert.equal(unconfirmed.json().code, 'call_guard');
  assert.equal((await f.state()).calls.length, 0);
  const active = await f.command('confirm', { revision: review.revision });
  const stale = await dial(review.revision);
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().code, 'call_guard');
  const disconnected = await f.command('comms', { down: true });
  assert.equal((await dial(disconnected.revision)).statusCode, 409);
  const current = await f.state();
  assert.equal(current.calls.length, active.calls.length);
  assert.ok(current.calls.every((call) => call.mode === 'mock'));
  await f.assertLocalOnly();
});

for (const story of ['grandfather', 'squad'] as const) {
  test(`${story} story passes a real review checkpoint, shared call slots, guarded dispatch, and trip-backed shelter arrival`, async (t) => {
    const f = await fixture(t);
    const before = await f.state();
    const review = await f.command('cycle-start', { revision: before.revision, demoStory: story });
    const residentId = story === 'grandfather' ? 'H012' : 'H009';
    const vehicleId = story === 'grandfather' ? 'V01' : 'V04';
    assert.equal(review.demonstration!.story, story);
    assert.equal(review.demonstration!.residentId, residentId);
    assert.equal(review.demonstration!.vehicleId, vehicleId);
    assert.equal(review.demonstration!.stage, 'ready');
    assert.equal(review.plan!.order[0]!.householdId, residentId);
    assert.equal(review.calls.length, 0);
    const graph = review.graphRuns.find((run) => run.waiting)!;
    const pending = await f
      .current()
      .agents.plan.getState({ configurable: { thread_id: graph.id } });
    assert.equal(pending.values.approved, false);
    assert.deepEqual(pending.values.order, review.plan!.order);
    assert.equal((await f.post('confirm', { revision: review.revision - 1 })).statusCode, 409);
    let view = await f.command('confirm', { revision: review.revision });
    view = await f.control({ revision: view.revision, speed: 60 });
    assert.equal(view.demonstration!.stage, 'dialing');
    const approved = await f
      .current()
      .agents.plan.getState({ configurable: { thread_id: graph.id } });
    assert.equal(approved.values.approved, true);
    assert.equal(approved.next.length, 0);
    assert.equal(view.calls.find((call) => call.targetId === residentId)!.phase, 'calling');
    const assertSlots = () => {
      assert.ok(
        view.calls.filter((call) => ['calling', 'pendingunknown'].includes(call.phase)).length <= 8,
      );
      assert.ok(view.calls.every((call) => call.mode === 'mock'));
    };
    assertSlots();
    f.clock.advance(250);
    view = await f.state();
    assert.equal(view.demonstration!.stage, 'talking');
    assert.ok(view.demonstration!.messages.some((message) => message.speaker === 'assistant'));
    f.clock.advance(750);
    view = await f.state();
    const residentCall = view.calls.find((call) => call.targetId === residentId)!;
    assert.equal(residentCall.phase, 'finished');
    assert.equal(residentCall.outcome, 'answered');
    assert.match(residentCall.text, /다리가 아파서.*차량/);
    assert.ok(
      view.demonstration!.messages.some(
        (message) => message.speaker === 'resident' && /다리가/.test(message.text),
      ),
    );
    assert.equal(
      view.shelterAdmissions.some((admission) => admission.householdId === residentId),
      false,
    );
    assertSlots();
    if (story === 'squad') {
      assert.equal(view.demonstration!.stage, 'requested');
      assert.equal(view.memberResponses.M01, 'waiting');
      assert.equal(
        view.trips.some((trip) => trip.householdId === residentId),
        false,
      );
      const memberCall = view.calls.find((call) => call.targetId === 'M01')!;
      assert.equal(memberCall.phase, 'queued');
      assert.equal(memberCall.nextAt, 5);
      assert.equal(
        (await f.post('member-response', { callId: memberCall.id, outcome: 'available' }))
          .statusCode,
        409,
      );
      f.clock.advance(4000);
      view = await f.state();
      assert.equal(view.calls.find((call) => call.targetId === 'M01')!.phase, 'calling');
      assert.equal(view.memberResponses.M01, 'waiting');
      assert.equal(
        view.trips.some((trip) => trip.householdId === residentId),
        false,
      );
      assertSlots();
      f.clock.advance(1000);
      view = await f.state();
      assert.equal(view.memberResponses.M01, 'ok');
    }
    const trip = view.trips.find((trip) => trip.householdId === residentId)!;
    assert.ok(trip);
    assert.equal(trip.stage, 'depart');
    assert.equal(trip.vehicleId, vehicleId);
    assert.equal(trip.shelterId, 'S2');
    assert.equal(trip.passengerCount, 1);
    assert.ok(trip.crewMemberIds.every((id) => view.memberResponses[id] === 'ok'));
    assert.equal(trip.crewMemberIds.length, story === 'squad' ? 2 : 1);
    assert.ok(trip.legs.pickup.roadIds.length > 0 && trip.legs.shelter.roadIds.length > 0);
    assert.equal(view.demonstration!.stage, 'responding');
    const forged = await f.post('trip', { id: trip.id, stage: 'shelter' });
    assert.equal(forged.statusCode, 409);
    view = await f.state();
    assert.equal(view.demonstration!.stage, 'responding');
    assert.equal(
      view.shelterAdmissions.some((admission) => admission.householdId === residentId),
      false,
    );
    const observed = new Set<Demonstration['stage']>([view.demonstration!.stage]);
    for (let i = 0; i < 60 && view.demonstration!.stage !== 'completed'; i++) {
      f.clock.advance(250);
      view = await f.state();
      observed.add(view.demonstration!.stage);
      assertSlots();
    }
    assert.equal(view.demonstration!.stage, 'completed');
    assert.ok(observed.has('boarding') && observed.has('evacuating'));
    const admissions = view.shelterAdmissions.filter(
      (admission) => admission.householdId === residentId,
    );
    assert.equal(admissions.length, 1);
    assert.equal(admissions[0]!.tripId, trip.id);
    assert.equal(admissions[0]!.shelterId, 'S2');
    assert.ok(view.simMinutes >= trip.shelterSim);
    assert.equal(
      view.scenario.householdStatuses.find((status) => status.householdId === residentId)!.status,
      'rescued',
    );
    assert.ok([...view.trips, ...view.completedTrips].some((current) => current.id === trip.id));
    const messages = view.demonstration!.messages;
    assert.equal(new Set(messages.map((message) => message.id)).size, messages.length);
    assert.ok(
      messages.every((message) =>
        message.text.startsWith('[합성 시연 텍스트·실모델/음성통화 아님]'),
      ),
    );
    assert.ok(
      messages.some((message) => message.speaker === 'member' && /가능/.test(message.text)),
    );
    assert.ok(
      messages.every(
        (message, index) => index === 0 || messages[index - 1]!.atSim <= message.atSim,
      ),
    );
    const saved = JSON.parse(readFileSync(join(f.journal, 'snapshot.json'), 'utf8')) as View;
    assert.deepEqual(saved.demonstration, view.demonstration);
    assert.deepEqual(saved.shelterAdmissions, view.shelterAdmissions);
    await f.assertLocalOnly();
  });
}
