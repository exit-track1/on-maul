import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server, IncomingHttpHeaders } from 'node:http';
import { createApp } from '../src/app.ts';
import { Config, type TelnyxPort } from '../src/telephony.ts';
import { phoneOutcome } from '../src/phone-integration.ts';
import type { PhonePort } from '../src/phone.ts';
import type { SimulationTimer } from '../src/simulation.ts';
import { Runtime, type View } from '../../shared/src/runtime.ts';
import { tripPosition } from '../../shared/src/dispatch.ts';
import type {
  PhoneCall,
  PhoneCompletion,
  PhoneState,
  PhoneTargetId,
  PhoneUpdate,
} from '../../shared/src/phone.ts';

const token = 'phone-api-test-operator-token-0000000000000000000000';
const headers = { authorization: `Bearer ${token}` };
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

class FakeClock implements SimulationTimer {
  milliseconds = 0;
  callbacks = new Map<symbol, () => void>();
  now = () => this.milliseconds;
  setInterval(callback: () => void) {
    const handle = Symbol('phone API simulation');
    this.callbacks.set(handle, callback);
    return handle;
  }
  clearInterval(handle: unknown) {
    this.callbacks.delete(handle as symbol);
  }
  advance(milliseconds: number) {
    this.milliseconds += milliseconds;
    for (const callback of this.callbacks.values()) callback();
  }
}

class FakePhone extends EventEmitter implements PhonePort {
  readonly probeToken = 'phone-api-test-probe';
  starts: { targetId: PhoneTargetId; requestId: string; shelterName?: string }[] = [];
  events: unknown[] = [];
  verificationCalls = 0;
  stops = 0;
  resets = 0;
  attachedServer?: Server;
  disposed = false;
  value: PhoneState = {
    enabled: true,
    ready: true,
    busy: false,
    notice: '테스트 음성 포트 준비',
    calls: [],
    targets: [
      {
        id: 'H012',
        name: '반영환 할아버지',
        scenario: 'resident',
        configured: true,
        phoneMasked: '010 •••• 0001',
        consent: true,
      },
      {
        id: 'M01',
        name: '반영환 대원',
        scenario: 'standby',
        configured: true,
        phoneMasked: '010 •••• 0003',
        consent: true,
      },
    ],
  };
  state() {
    return structuredClone(this.value);
  }
  async start(targetId: PhoneTargetId, requestId: string, shelterName?: string) {
    assert.equal(this.disposed, false);
    assert.equal(this.value.busy, false);
    this.starts.push({ targetId, requestId, shelterName });
    const target = this.value.targets.find((candidate) => candidate.id === targetId)!;
    const call: PhoneCall = {
      id: randomUUID(),
      requestId,
      targetId,
      targetName: target.name,
      scenario: target.scenario,
      providerId: `fake-provider-${requestId}`,
      status: 'created',
      blocked: true,
      requestedAt: Date.now(),
      answeredAt: null,
      endedAt: null,
      transcript: [],
      notice: '발신 접수',
    };
    this.value.calls.push(call);
    this.value.busy = true;
    this.emit('update', { requestId, call: structuredClone(call) } satisfies PhoneUpdate);
    return structuredClone(call);
  }
  update(targetId: PhoneTargetId, patch: Partial<PhoneCall>) {
    const call = this.value.calls.findLast((candidate) => candidate.targetId === targetId)!;
    assert.ok(call, `phone call for ${targetId} missing`);
    Object.assign(call, structuredClone(patch));
    this.value.busy = this.value.calls.some((candidate) => candidate.blocked);
    this.emit('update', {
      requestId: call.requestId,
      call: structuredClone(call),
    } satisfies PhoneUpdate);
    return structuredClone(call);
  }
  async stop(callId?: string) {
    const call =
      this.value.calls.find((candidate) => candidate.id === callId) ?? this.value.calls.at(-1);
    this.stops++;
    if (call?.blocked) this.update(call.targetId, { status: 'ending', blocked: true });
    return this.state();
  }
  resolveUnknown(callId: string, confirmed: boolean) {
    const call = this.value.calls.find((candidate) => candidate.id === callId)!;
    assert.equal(call.status, 'unknown');
    assert.equal(confirmed, true);
    this.update(call.targetId, { status: 'ended', blocked: false, endedAt: Date.now() });
    return this.state();
  }
  resetHistory() {
    assert.equal(this.value.busy, false);
    this.resets++;
    this.value.calls = [];
    return this.state();
  }
  verifyWebhook(_raw: Buffer, requestHeaders: IncomingHttpHeaders) {
    this.verificationCalls++;
    return requestHeaders['telnyx-signature-ed25519'] === 'fake-verified-signature';
  }
  webhook(event: unknown) {
    this.events.push(event);
  }
  attachUpgrade(server: Server) {
    this.attachedServer = server;
  }
  dispose() {
    this.disposed = true;
  }
}

function rescue(evidence = '다리가 아파 움직일 수 없어요. 차를 보내주세요.'): PhoneCompletion {
  return {
    status: 'reported',
    kind: 'rescue',
    location: '집',
    evidence,
    recordedAt: Date.now(),
    playbackConfirmed: true,
    assessment: {
      stage: 'done',
      location: '집',
      shelterName: '온빛 배움학교',
      mobility: 'needs_help',
      condition: 'uncomfortable',
      refusal: 'willing',
      emergency: false,
      answers: [{ question: '이동 가능하십니까?', text: evidence }],
      reason: '스스로 이동 불가',
    },
  };
}

function squadReady(
  vehicleEvidence = '차량 있습니다',
  readinessEvidence = '지금 바로 출발합니다',
): PhoneCompletion {
  return {
    status: 'reported',
    kind: 'standby',
    location: '대기조 확인',
    evidence: readinessEvidence,
    recordedAt: Date.now(),
    playbackConfirmed: true,
    standbyAssessment: {
      state: 'ready',
      participationEvidence: '참여 가능합니다',
      vehicleEvidence,
      readinessEvidence,
      evidence: readinessEvidence,
      confidence: 0.99,
    },
  };
}

async function fixture(t: TestContext, phone = new FakePhone()) {
  const journal = mkdtempSync(join(tmpdir(), 'onmaul-phone-api-'));
  const clock = new FakeClock();
  const settings = Config.parse({ mode: 'hybrid', operatorToken: token });
  let transportCalls = 0;
  const port: TelnyxPort = {
    async dial() {
      transportCalls++;
      throw new Error('external dial forbidden');
    },
    async hangup() {
      transportCalls++;
      throw new Error('external hangup forbidden');
    },
  };
  let session = await createApp({
    settings,
    phone,
    port,
    journal,
    simulation: { now: clock.now, timer: clock },
  });
  t.after(async () => {
    await session.app.close();
    rmSync(journal, { recursive: true, force: true });
    assert.equal(clock.callbacks.size, 0);
    assert.equal(transportCalls, 0, 'the legacy telephone transport must never be used');
  });
  const f = {
    clock,
    phone,
    current: () => session,
    post: (action: string, input: Record<string, unknown> = {}) =>
      session.app.inject({
        method: 'POST',
        url: '/api/command',
        headers,
        payload: { action, input },
      }),
    async command(action: string, input: Record<string, unknown> = {}) {
      const response = await f.post(action, input);
      assert.equal(response.statusCode, 200, response.body);
      return response.json<View>();
    },
    async state() {
      const response = await session.app.inject({ url: '/api/state', headers });
      assert.equal(response.statusCode, 200, response.body);
      return response.json<View>();
    },
    async drain() {
      await flush();
      const view = await f.state();
      await flush();
      return view;
    },
    async advance(minutes: number) {
      const before = await f.state();
      clock.advance((minutes * 60000) / before.simulation.speed);
      return f.state();
    },
    async start(
      story: 'grandfather' | 'squad' = 'grandfather',
      phoneMode: 'live' | 'mock' = 'live',
    ) {
      const before = await f.state();
      const review = await f.command('cycle-start', {
        revision: before.revision,
        demoStory: story,
        phoneMode,
        phoneConsent: true,
      });
      assert.equal(phone.starts.length, 0);
      await f.command('confirm', { revision: review.revision });
      return f.drain();
    },
    async restart(recovered: FakePhone) {
      await session.app.close();
      session = await createApp({
        settings,
        phone: recovered,
        port,
        journal,
        simulation: { now: clock.now, timer: clock },
      });
      return f.drain();
    },
  };
  return f;
}

function householdStatus(view: View, id: string) {
  return view.scenario.householdStatuses.find((status) => status.householdId === id)!;
}

test('API waits for current human checkpoint, applies rescue after carrier termination, and animates the ambulance', async (t) => {
  const f = await fixture(t);
  const before = await f.state();
  const review = await f.command('cycle-start', {
    revision: before.revision,
    demoStory: 'grandfather',
    phoneMode: 'live',
    phoneConsent: true,
  });
  const checkpoint = review.graphRuns.find((run) => run.waiting)!;
  assert.equal(f.phone.starts.length, 0);
  assert.equal((await f.post('confirm', { revision: review.revision - 1 })).statusCode, 409);
  assert.equal(f.phone.starts.length, 0);
  await f.command('confirm', { revision: review.revision });
  let view = await f.drain();
  assert.deepEqual(
    f.phone.starts.map((call) => call.targetId),
    ['H012'],
  );
  assert.ok(f.phone.starts[0].shelterName);
  assert.equal(f.phone.attachedServer, f.current().app.server);
  assert.equal(view.graphRuns.find((run) => run.id === checkpoint.id)!.waiting, false);
  assert.equal(
    (await f.current().agents.plan.getState({ configurable: { thread_id: checkpoint.id } })).values
      .approved,
    true,
  );
  assert.equal(view.demonstration!.phoneClockHeld, false);
  assert.equal(view.calls.filter((call) => call.targetId === 'H012').length, 1);

  f.phone.update('H012', {
    status: 'answered',
    answeredAt: Date.now(),
    transcript: [{ speaker: 'user', text: '차를 보내주세요' }],
    completion: rescue(),
    blocked: true,
  });
  view = await f.drain();
  assert.equal(householdStatus(view, 'H012').status, 'calling');
  assert.equal(view.demonstration!.stage, 'talking');
  const answeredAtDisplay = view.scenario.displayTime;
  view = await f.advance(1);
  assert.equal(view.simMinutes, 1);
  assert.notEqual(view.scenario.displayTime, answeredAtDisplay);
  assert.equal(f.phone.starts.length, 1);
  assert.ok(!view.trips.some((trip) => trip.householdId === 'H012'));
  f.phone.update('H012', { status: 'ending', blocked: true });
  view = await f.drain();
  assert.equal(householdStatus(view, 'H012').status, 'calling');
  assert.ok(!view.calls.find((call) => call.targetId === 'H012')!.phoneOutcome);

  f.phone.update('H012', { status: 'ended', blocked: false, endedAt: Date.now() });
  view = await f.drain();
  assert.equal(householdStatus(view, 'H012').status, 'help');
  assert.equal(
    view.memberResponses.M02,
    'ok',
    'ambulance operator availability is an explicit demo resource assumption',
  );
  assert.ok(!view.calls.some((call) => call.targetId === 'M02'));
  assert.equal(view.demonstration!.phoneClockHeld, false);
  assert.ok(!view.trips.some((trip) => trip.householdId === 'H012'));
  view = await f.advance(1);
  const trip = view.trips.find((trip) => trip.householdId === 'H012')!;
  assert.ok(trip);
  assert.equal(trip.vehicleId, 'V01');
  assert.equal(trip.driverRef, 'M02');
  assert.equal(view.memberResponses.M02, 'ok');
  assert.equal(view.demonstration!.stage, 'responding');
  const current = tripPosition(trip, view.simMinutes);
  view = await f.advance(0.5);
  const moved = tripPosition(trip, view.simMinutes);
  assert.notDeepEqual(moved, current);
  assert.equal(f.phone.starts.length, 1);
  const phoneState = await f.current().app.inject({ url: '/api/phone/state', headers });
  assert.equal(phoneState.statusCode, 200);
  assert.equal(phoneState.json<PhoneState>().calls[0].transcript[0].text, '차를 보내주세요');
});

test('squad API dispatches to H009 after the captured immediate-departure response and final M01 termination', async (t) => {
  const f = await fixture(t);
  await f.start('squad');
  assert.deepEqual(
    f.phone.starts.map((call) => call.targetId),
    ['M01'],
  );
  let view = await f.drain();
  assert.ok(!view.calls.some((call) => call.targetId === 'H009'));
  assert.equal(householdStatus(view, 'H009').status, 'help');
  assert.equal(view.demonstration!.phoneClockHeld, false);
  const completion = squadReady(
    '네 앞에 내 폰 차량 있어서 해당 차량 타고 이동하겠습니다',
    '네 지금 즉시 출동 가능합니다',
  );
  completion.standbyAssessment!.participationEvidence = '어 네 지금 이동가능합니다';
  f.phone.update('M01', { status: 'answered', answeredAt: Date.now(), completion });
  view = await f.drain();
  assert.equal(view.memberResponses.M01, 'waiting');
  view = await f.advance(1);
  assert.equal(view.simMinutes, 1);
  assert.equal(view.memberResponses.M01, 'waiting');
  assert.equal(f.phone.starts.length, 1);
  assert.ok(!view.trips.some((trip) => trip.householdId === 'H009'));
  f.phone.update('M01', { status: 'ended', blocked: false, endedAt: Date.now() });
  view = await f.drain();
  assert.equal(view.memberResponses.M01, 'ok');
  view = await f.advance(1);
  const trip = view.trips.find((trip) => trip.householdId === 'H009')!;
  assert.ok(trip);
  assert.equal(trip.vehicleId, 'V04');
  assert.equal(trip.driverRef, 'M01');
  assert.ok(trip.crewMemberIds.length >= 2);
  assert.ok(trip.crewMemberIds.every((id) => view.memberResponses[id] === 'ok'));
  assert.equal(view.demonstration!.stage, 'responding');
  assert.equal(f.phone.starts.length, 1);
  while (view.simMinutes < trip.shelterSim + 0.1)
    view = await f.advance(Math.min(1, trip.shelterSim + 0.1 - view.simMinutes));
  assert.equal(view.trips.find((item) => item.id === trip.id)!.stage, 'shelter');
  assert.equal(householdStatus(view, 'H009').status, 'rescued');
  assert.equal(view.demonstration!.stage, 'completed');
});

test('confirmed reset clears frozen demo state and phone history, stays reset after restart, and makes no call', async (t) => {
  const f = await fixture(t);
  await f.start();
  f.phone.update('H012', {
    status: 'ended',
    blocked: false,
    answeredAt: Date.now(),
    endedAt: Date.now(),
    completion: rescue(),
  });
  await f.drain();
  await f.advance(1);
  const oldCall = f.phone.state().calls[0];
  const before = await f.command('close', { acknowledged: true });
  const targets = f.phone.state().targets;
  assert.equal(before.frozen, true);
  assert.ok(before.calls.length > 0);
  assert.ok(before.simMinutes > 0);
  const reset = await f.command('demo-reset', { revision: before.revision, confirmed: true });
  const pristine = new Runtime().view();
  assert.equal(reset.revision, before.revision + 1);
  assert.deepEqual(reset.scenario, pristine.scenario);
  assert.deepEqual(reset.data.households, pristine.data.households);
  assert.deepEqual(reset.records, pristine.records);
  assert.deepEqual(reset.memberResponses, pristine.memberResponses);
  assert.equal(reset.simMinutes, 0);
  assert.equal(reset.simulation.phase, 'idle');
  assert.equal(reset.simulation.playing, false);
  assert.equal(reset.frozen, false);
  assert.equal(reset.demonstration, null);
  for (const key of ['calls', 'trips', 'completedTrips', 'graphRuns', 'shelterAdmissions'] as const)
    assert.deepEqual(reset[key], []);
  assert.equal(f.phone.resets, 1);
  assert.deepEqual(f.phone.state().calls, []);
  assert.deepEqual(f.phone.state().targets, targets);
  assert.equal(f.phone.starts.length, 1);
  f.phone.emit('update', { requestId: oldCall.requestId, call: oldCall } satisfies PhoneUpdate);
  assert.deepEqual((await f.drain()).calls, []);
  assert.deepEqual((await f.advance(1)).simulation, reset.simulation);
  const recovered = new FakePhone();
  recovered.value = f.phone.state();
  const restored = await f.restart(recovered);
  assert.equal(restored.scenario.id, 'idle');
  assert.equal(restored.simMinutes, 0);
  assert.deepEqual(restored.calls, []);
  assert.deepEqual(restored.graphRuns, []);
  assert.deepEqual(recovered.state().calls, []);
  assert.equal(recovered.starts.length, 0);
});

test('reset requires bearer auth, confirmation and current revision, and refuses active or unknown calls', async (t) => {
  const f = await fixture(t);
  await f.start();
  const before = await f.state();
  const missingConfirmation = await f.post('demo-reset', { revision: before.revision });
  assert.equal(missingConfirmation.statusCode, 409);
  assert.equal(missingConfirmation.json().code, 'reset_confirmation');
  const stale = await f.post('demo-reset', { revision: before.revision - 1, confirmed: true });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().code, 'stale_revision');
  const unauthorized = await f.current().app.inject({
    method: 'POST',
    url: '/api/command',
    payload: { action: 'demo-reset', input: { revision: before.revision, confirmed: true } },
  });
  assert.equal(unauthorized.statusCode, 401);
  for (const status of ['answered', 'unknown'] as const) {
    f.phone.update('H012', { status, blocked: true });
    const current = await f.drain();
    const response = await f.post('demo-reset', { revision: current.revision, confirmed: true });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().code, 'live_session');
    assert.equal(f.phone.resets, 0);
    assert.equal(f.phone.state().calls.length, 1);
  }
  const unbound = new FakePhone();
  unbound.value.busy = true;
  const other = await fixture(t, unbound);
  const response = await other.post('demo-reset', {
    revision: (await other.state()).revision,
    confirmed: true,
  });
  assert.equal(response.statusCode, 409);
  assert.equal(unbound.resets, 0);
});

test('deployed dashboards bootstrap the environment token without caching and keep API bearer checks', async (t) => {
  const f = await fixture(t);
  for (const requestHeaders of [
    { host: 'onmaul.example' },
    { host: 'onmaul.example', origin: 'https://onmaul.example', 'x-forwarded-proto': 'https' },
    {
      host: 'internal:8090',
      origin: 'https://onmaul.example',
      'x-forwarded-host': 'onmaul.example',
      'x-forwarded-proto': 'https',
    },
    { host: 'localhost:8090', origin: 'http://localhost:8090' },
  ]) {
    const bootstrap = await f.current().app.inject({
      url: '/api/phone/bootstrap',
      headers: requestHeaders,
    });
    assert.equal(bootstrap.statusCode, 200);
    assert.equal(bootstrap.headers['cache-control'], 'no-store');
    assert.deepEqual(bootstrap.json(), { enabled: true, token });
    const state = await f.current().app.inject({
      url: '/api/phone/state',
      headers: { authorization: `Bearer ${bootstrap.json().token}` },
    });
    assert.equal(state.statusCode, 200);
  }
  const crossOrigin = await f.current().app.inject({
    url: '/api/phone/bootstrap',
    headers: {
      host: 'onmaul.example',
      origin: 'https://another.example',
      'x-forwarded-proto': 'https',
    },
  });
  assert.equal(crossOrigin.statusCode, 403);
  assert.equal(crossOrigin.headers['cache-control'], 'no-store');
  assert.ok(!crossOrigin.body.includes(token));
  const unauthenticated = await f.current().app.inject('/api/phone/state');
  assert.equal(unauthenticated.statusCode, 401);
  assert.equal(f.phone.starts.length, 0);
});

test('disabled telephone bootstrap returns no operator token', async (t) => {
  const phone = new FakePhone();
  phone.value.enabled = false;
  phone.value.ready = false;
  const f = await fixture(t, phone);
  const bootstrap = await f.current().app.inject({
    url: '/api/phone/bootstrap',
    headers: { host: 'onmaul.example' },
  });
  assert.equal(bootstrap.statusCode, 200);
  assert.equal(bootstrap.headers['cache-control'], 'no-store');
  assert.deepEqual(bootstrap.json(), { enabled: false, token: '' });
});

test('enabled voice rejects mock cycles and phone endpoints require the operator token', async (t) => {
  const f = await fixture(t);
  const before = await f.state();
  const blocked = await f.post('cycle-start', {
    revision: before.revision,
    demoStory: 'grandfather',
    phoneMode: 'mock',
  });
  assert.equal(blocked.statusCode, 409, blocked.body);
  assert.equal(blocked.json().code, 'actual_phone_only');
  assert.equal(f.phone.starts.length, 0);
  for (const action of ['transcript', 'member-response', 'schedule-callback', 'plan']) {
    const response = await f.post(action, {});
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json().code, 'actual_phone_only');
  }
  const staticCalls = await f.post('scenario', { id: 'active' });
  assert.equal(staticCalls.statusCode, 409, staticCalls.body);
  assert.equal(staticCalls.json().code, 'actual_phone_only');
  assert.equal((await f.state()).revision, before.revision);
  for (const request of [
    { method: 'GET' as const, url: '/api/phone/state' },
    { method: 'POST' as const, url: '/api/phone/hangup', payload: {} },
    {
      method: 'POST' as const,
      url: '/api/phone/dial',
      payload: { targetId: 'H012', consent: true, revision: 1 },
    },
  ]) {
    const response = await f.current().app.inject(request);
    assert.equal(response.statusCode, 401, response.body);
  }
  assert.equal(f.phone.stops, 0);
  assert.equal(f.phone.starts.length, 0);
});

test('disabled test harness retains mock playback with zero voice starts', async (t) => {
  const phone = new FakePhone();
  phone.value.enabled = false;
  phone.value.ready = false;
  const f = await fixture(t, phone);
  await f.start('grandfather', 'mock');
  await f.advance(10);
  assert.equal(phone.starts.length, 0);
});

test('public callback skips operator auth only after signature verification and shares the dashboard probe', async (t) => {
  const f = await fixture(t);
  const probe = await f.current().app.inject(`/probe/${f.phone.probeToken}`);
  assert.equal(probe.statusCode, 200);
  assert.deepEqual(probe.json(), { onCallback: f.phone.probeToken });
  const payload = { data: { id: 'test-webhook', event_type: 'call.answered', payload: {} } };
  const invalid = await f
    .current()
    .app.inject({ method: 'POST', url: '/webhooks/telnyx', payload });
  assert.equal(invalid.statusCode, 401);
  assert.equal(f.phone.events.length, 0);
  const valid = await f.current().app.inject({
    method: 'POST',
    url: '/webhooks/telnyx',
    headers: { 'telnyx-signature-ed25519': 'fake-verified-signature' },
    payload,
  });
  assert.equal(valid.statusCode, 200, valid.body);
  assert.deepEqual(f.phone.events, [payload]);
  assert.equal(f.phone.verificationCalls, 2);
});

test('missing consent, wrong story target, and stale revisions fail without starting a voice session', async (t) => {
  const f = await fixture(t);
  const before = await f.state();
  const noConsent = await f.post('cycle-start', { revision: before.revision, phoneMode: 'live' });
  assert.equal(noConsent.statusCode, 409);
  assert.equal((await f.state()).revision, before.revision);
  const review = await f.command('cycle-start', {
    revision: before.revision,
    phoneMode: 'live',
    phoneConsent: true,
  });
  const dial = (targetId: PhoneTargetId, revision: number, consent = true) =>
    f.current().app.inject({
      method: 'POST',
      url: '/api/phone/dial',
      headers,
      payload: { targetId, revision, consent },
    });
  assert.equal((await dial('M01', review.revision)).statusCode, 409);
  const assumedResidentDial = await f.current().app.inject({
    method: 'POST',
    url: '/api/phone/dial',
    headers,
    payload: { targetId: 'H009', revision: review.revision, consent: true },
  });
  assert.equal(assumedResidentDial.statusCode, 400);
  assert.equal((await dial('H012', review.revision, false)).statusCode, 400);
  assert.equal((await f.post('confirm', { revision: review.revision - 1 })).statusCode, 409);
  assert.equal(f.phone.starts.length, 0);
  assert.equal((await f.state()).calls.length, 0);

  const unavailable = f.phone.value.targets.find((target) => target.id === 'M01')!;
  unavailable.consent = false;
  const missingTargetConsent = await f.post('cycle-start', {
    revision: review.revision,
    demoStory: 'squad',
    phoneMode: 'live',
    phoneConsent: true,
  });
  assert.equal(missingTargetConsent.statusCode, 409);
  assert.equal(f.phone.starts.length, 0);
});

test('manual dial validates the current runtime revision and returns its bound request without blocking state reads', async (t) => {
  const f = await fixture(t);
  const before = await f.state();
  const review = await f.command('cycle-start', {
    revision: before.revision,
    phoneMode: 'live',
    phoneConsent: true,
  });
  f.phone.value.ready = false;
  const confirmed = await f.command('confirm', { revision: review.revision });
  assert.equal(f.phone.starts.length, 0);
  f.phone.value.ready = true;
  const stale = await f.current().app.inject({
    method: 'POST',
    url: '/api/phone/dial',
    headers,
    payload: { targetId: 'H012', revision: review.revision, consent: true },
  });
  assert.equal(stale.statusCode, 409, stale.body);
  assert.equal(f.phone.starts.length, 0);
  const response = await f.current().app.inject({
    method: 'POST',
    url: '/api/phone/dial',
    headers,
    payload: { targetId: 'H012', revision: confirmed.revision, consent: true },
  });
  assert.equal(response.statusCode, 200, response.body);
  const result = response.json<{ requestId: string; view: View; phone: PhoneState }>();
  assert.ok(result.requestId);
  assert.ok(
    result.view.calls.some((call) => call.id === result.requestId && call.targetId === 'H012'),
  );
  assert.equal(result.phone.busy, true);
  await f.drain();
  assert.equal(f.phone.starts.length, 1);
  assert.equal(f.phone.starts[0].requestId, result.requestId);
  const duplicate = await f.current().app.inject({
    method: 'POST',
    url: '/api/phone/dial',
    headers,
    payload: { targetId: 'H012', revision: (await f.state()).revision, consent: true },
  });
  assert.equal(duplicate.statusCode, 409, duplicate.body);
  assert.equal(f.phone.starts.length, 1);
});

test('restart with unknown carrier state preserves call guards; hangup acceptance cannot unlock reset', async (t) => {
  const f = await fixture(t);
  await f.start();
  f.phone.update('H012', { status: 'answered', answeredAt: Date.now() });
  await f.drain();
  const active = f.phone.state().calls[0];
  const stop = await f.current().app.inject({
    method: 'POST',
    url: '/api/phone/hangup',
    headers,
    payload: { callId: active.id },
  });
  assert.equal(stop.statusCode, 200, stop.body);
  assert.equal(stop.json().phone.busy, true);
  const held = await f.drain();
  assert.equal((await f.post('cycle-start', { revision: held.revision })).statusCode, 409);
  assert.ok(!held.trips.some((trip) => trip.householdId === 'H012'));
  const recovered = new FakePhone();
  recovered.value = f.phone.state();
  Object.assign(recovered.value.calls[0], { status: 'unknown', blocked: true });
  let view = await f.restart(recovered);
  assert.equal(recovered.starts.length, 0);
  assert.equal(view.demonstration!.phoneClockHeld, false);
  assert.equal(view.calls.find((call) => call.id === active.requestId)!.phase, 'pendingunknown');
  assert.equal((await f.advance(1)).simMinutes, 0, 'restart still requires a manual resume');
  assert.equal((await f.post('cycle-start', { revision: view.revision })).statusCode, 409);
  const resolve = await f.current().app.inject({
    method: 'POST',
    url: '/api/phone/resolve',
    headers,
    payload: { callId: active.id, confirmedEnded: true },
  });
  assert.equal(resolve.statusCode, 200, resolve.body);
  view = await f.drain();
  assert.equal(householdStatus(view, 'H012').status, 'unclear');
  assert.equal(view.demonstration!.phoneClockHeld, false);
  assert.ok(!view.trips.some((trip) => trip.householdId === 'H012'));
  assert.equal(recovered.starts.length, 0);
});

test('long recipient evidence is bounded for runtime without dropping a verified phone outcome', async (t) => {
  const f = await fixture(t);
  await f.start();
  const completion = rescue('이동이 어렵습니다. '.repeat(400));
  f.phone.update('H012', { status: 'ended', blocked: false, endedAt: Date.now(), completion });
  const view = await f.drain();
  assert.equal(householdStatus(view, 'H012').status, 'help');
  const runtimeCall = view.calls.find((call) => call.targetId === 'H012')!;
  assert.ok(runtimeCall.phoneOutcome);
  assert.ok(runtimeCall.phoneOutcome.evidence!.length <= 2000);
  assert.equal(f.phone.value.calls[0].completion!.evidence, completion.evidence);
});

test('standby mapping declines vague or negative vehicle/readiness claims and accepts immediate available transport', () => {
  const call: PhoneCall = {
    id: randomUUID(),
    requestId: 'mapping',
    targetId: 'M01',
    targetName: '반영환 대원',
    scenario: 'standby',
    providerId: 'fake-provider',
    status: 'ended',
    blocked: false,
    requestedAt: 1,
    answeredAt: 2,
    endedAt: 3,
    transcript: [],
    notice: '',
  };
  for (const vehicle of ['차량 없습니다', '차량 이용이 어렵습니다', '차량이 있을 수도 있습니다']) {
    const mapped = phoneOutcome({ ...call, completion: squadReady(vehicle) });
    assert.equal(mapped.standbyAvailable, false, vehicle);
  }
  for (const readiness of [
    '10분 후 가능합니다',
    '지금 바로 출발하지 못합니다',
    '준비 시간은 아직 모르겠습니다',
    '지금부터 30분 걸립니다',
    '지금 바로는 출발 안 할 거예요',
    '지금 즉시 출동할 수 없습니다',
    '지금 안 출동합니다',
    '즉시 출동 불가합니다',
  ]) {
    const mapped = phoneOutcome({ ...call, completion: squadReady('차량 있습니다', readiness) });
    assert.equal(mapped.standbyAvailable, false, readiness);
  }
  assert.equal(phoneOutcome({ ...call, completion: squadReady() }).standbyAvailable, true);
  for (const readiness of [
    '네 지금 즉시 출동 가능합니다',
    '지금 출동 가능합니다',
    '바로 출동하겠습니다',
    '즉시 출동합니다',
    '지금 이동가능합니다',
  ]) {
    assert.equal(
      phoneOutcome({ ...call, completion: squadReady('차량 있습니다', readiness) })
        .standbyAvailable,
      true,
      readiness,
    );
  }
});
