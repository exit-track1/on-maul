import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createApp } from '../src/app.ts';
import { AgentGraphs } from '../src/agents.ts';
import { config, Telephony, verifyWebhook } from '../src/telephony.ts';
import { Runtime } from '../../shared/src/runtime.ts';
test('automatic failed-team proposals use actual LangGraph checkpoints and require officer approval', async () => {
  const { app, runtime } = await createApp({ settings: config({}) });
  try {
    runtime.command('watch');
    runtime.command('plan');
    runtime.command('confirm', { revision: runtime.view().revision });
    const snapshot = runtime.view();
    snapshot.data.map.ignition = { x: 0, y: 0 };
    snapshot.data.map.wind = { direction: 270, speedMps: 0 };
    for (const h of snapshot.data.households) {
      h.demoPosition = { x: 900, y: 550 };
      h.mobility = '자력';
      h.devices = [];
      h.shelterId = 'S2';
    }
    for (const c of snapshot.calls) {
      c.phase = 'finished';
      c.outcome = 'answered';
    }
    for (const s of snapshot.scenario.householdStatuses)
      s.status = snapshot.data.households.find((h) => h.id === s.householdId)!.callEligible
        ? 'help'
        : 'visit';
    snapshot.memberResponses = Object.fromEntries(
      snapshot.data.teams.flatMap((t) =>
        t.members.map((m) => [m.id, m.availability === '가능' ? ('ok' as const) : ('no' as const)]),
      ),
    );
    snapshot.memberResponses.M01 = 'waiting';
    snapshot.memberResponses.M02 = 'no';
    snapshot.memberResponses.M03 = 'no';
    const c = snapshot.calls.find((c) => c.targetId === 'M01')!;
    c.phase = 'calling';
    c.outcome = undefined;
    runtime.restore(snapshot);
    runtime.command('comms', { down: false });
    const result = await app.inject({
      method: 'POST',
      url: '/api/command',
      payload: { action: 'member-response', input: { callId: c.id, outcome: 'unavailable' } },
    });
    assert.equal(result.statusCode, 200);
    const v = result.json();
    assert.ok(v.reassignments.length > 0);
    assert.equal(v.trips.length, 0);
    for (const p of v.reassignments)
      assert.ok(
        v.graphRuns.some(
          (g: { id: string; waiting: boolean }) => g.id === `REASSIGN-GRAPH-${p.id}` && g.waiting,
        ),
      );
    assert.equal((await app.inject('/api/health')).json().externalInferenceCalls, 0);
  } finally {
    await app.close();
  }
});
test('actual reassignment graph pauses before assignment and records rejection or approved candidate', async () => {
  const r = new Runtime();
  r.command('scenario', { id: 'active' });
  const p = r.command('reassign-propose', { id: 'H041', revision: r.view().revision })
    .reassignments[0];
  const g = new AgentGraphs();
  const waiting = await g.proposeReassignment('reassign-checkpoint', p);
  assert.equal(waiting.waiting, true);
  assert.equal(r.view().trips.length, 0);
  assert.ok(!waiting.nodes.some((n) => n.startsWith('approved_')));
  const completed = await g.decideReassignment(
    'reassign-checkpoint',
    true,
    p.candidates[0].vehicleId,
  );
  assert.equal(completed.waiting, false);
  assert.ok(completed.nodes.includes('reassignment_officer_review'));
  const second = await g.proposeReassignment('reassign-reject', p);
  assert.equal(second.waiting, true);
  assert.ok(
    (await g.decideReassignment('reassign-reject', false, null)).nodes.includes(
      'reassignment_not_executed',
    ),
  );
});
test('API reassignment approval uses current revision, resumes graph and reserves validated routes only once', async () => {
  const { app } = await createApp({ settings: config({}) });
  try {
    const post = (action: string, input: Record<string, unknown> = {}) =>
      app.inject({ method: 'POST', url: '/api/command', payload: { action, input } });
    let view = (await post('scenario', { id: 'active' })).json();
    view = (await post('reassign-propose', { id: 'H041', revision: view.revision })).json();
    const proposal = view.reassignments[0],
      selected = proposal.candidates[0].vehicleId;
    assert.equal(view.trips.length, 0);
    assert.equal(view.graphRuns.at(-1).waiting, true);
    const input = { id: proposal.id, vehicleId: selected, revision: view.revision };
    assert.equal(
      (await post('reassign-approve', { ...input, revision: input.revision - 1 })).statusCode,
      409,
    );
    assert.equal((await app.inject('/api/state')).json().trips.length, 0);
    const approved = await post('reassign-approve', input);
    assert.equal(approved.statusCode, 200);
    view = approved.json();
    assert.equal(view.trips.length, 1);
    assert.equal(view.graphRuns.at(-1).waiting, false);
    assert.equal((await post('reassign-approve', input)).json().trips.length, 1);
    const trip = view.trips[0];
    assert.ok(trip.legs.pickup.roadIds.length > 0);
    assert.equal(trip.passengerCount, 1);
    view = (
      await post('road-control', {
        id: trip.legs.pickup.roadIds[0],
        blocked: true,
        revision: view.revision,
      })
    ).json();
    assert.ok(view.trips[0].heldReason);
    assert.equal((await post('advance')).json().trips.length, 1);
    assert.equal((await app.inject('/api/health')).json().externalInferenceCalls, 0);
  } finally {
    await app.close();
  }
});
test('actual LangGraph plan interrupts and resumes the same checkpoint', async () => {
  const g = new AgentGraphs(),
    r = new Runtime();
  const p = await g.propose('review-test', 1, r.planItems());
  assert.equal(p.waiting, true);
  assert.ok(p.nodes.includes('validate_targets'));
  assert.ok(!p.nodes.includes('approved_proposal_no_external_effect'));
  const result = await g.confirm('review-test');
  assert.equal(result.waiting, false);
  assert.ok(result.nodes.includes('officer_review'));
  assert.ok(result.nodes.includes('approved_proposal_no_external_effect'));
});
test('graph routes emergency automatically and uncertain speech to human checkpoint', async () => {
  const g = new AgentGraphs(),
    r = new Runtime();
  let x = await g.classify('emergency', '숨쉬기 힘들어요', r.view(), 'H012');
  assert.equal(x.result.status, 'e119');
  assert.equal(x.run.waiting, false);
  assert.ok(x.run.nodes.includes('emergency_proposal_auto_mock_handoff'));
  x = await g.classify('unclear', '네', r.view(), 'H009');
  assert.equal(x.run.waiting, true);
  assert.equal(x.result.acked, false);
  const done = await g.review('unclear');
  assert.equal(done.waiting, false);
});
test('API full mock flow, stale confirmation and health metadata', async () => {
  const { app } = await createApp({ settings: config({}) });
  try {
    const post = (action: string, input: Record<string, unknown> = {}) =>
      app.inject({ method: 'POST', url: '/api/command', payload: { action, input } });
    assert.equal((await app.inject('/api/health')).json().externalInferenceCalls, 0);
    await post('watch');
    let v = (await post('plan')).json();
    assert.equal(v.graphRuns[0].waiting, true);
    assert.equal(v.calls.length, 0);
    assert.equal((await post('confirm', { revision: v.revision - 1 })).statusCode, 409);
    v = (await post('confirm', { revision: v.revision })).json();
    assert.equal(v.calls.filter((c: any) => c.phase === 'calling').length, 8);
    assert.equal(v.graphRuns.at(-1).waiting, false);
    v = (
      await post('transcript', { id: 'H012', text: '숨쉬기 힘들어요', eventId: 'emergency-1' })
    ).json();
    assert.equal(v.handoffs.at(-1).status, 'mockRecorded');
    assert.equal(v.graphRuns.at(-1).waiting, false);
    const exportResponse = await app.inject('/api/export.json');
    assert.equal(exportResponse.statusCode, 200);
    assert.equal(exportResponse.json().handoffs.length, v.handoffs.length);
    assert.equal((await post('close', { acknowledged: true })).json().frozen, true);
    assert.equal((await post('advance')).statusCode, 409);
  } finally {
    await app.close();
  }
});
test('demo telephony performs zero network calls even when keys are configured', async () => {
  let count = 0;
  const fake = {
    calls: {
      dial: () => {
        count++;
        throw new Error('network');
      },
    },
  };
  const p = new Telephony(config({ TELNYX_API_KEY: 'not-a-real-key' }), fake as any);
  const result = await p.dial({
    targetId: 'H012',
    targetType: 'resident',
    consent: true,
    requestId: 'demo-request',
  });
  assert.equal(result.mode, 'mock');
  assert.equal(count, 0);
});
test('unknown modes and incomplete hybrid configuration fail closed', () => {
  assert.throws(() => config({ ON_EXECUTION_MODE: 'live' }));
  assert.throws(() => config({ ON_EXECUTION_MODE: 'hybrid' }));
});
test('Ed25519 raw-body signature, tampering and timestamp replay window', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519'),
    pub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64'),
    raw = JSON.stringify({ data: { id: 'event1' } }),
    ts = String(Math.floor(Date.now() / 1000)),
    signature = sign(null, Buffer.from(`${ts}|${raw}`), privateKey).toString('base64');
  assert.equal(verifyWebhook(raw, signature, ts, pub), true);
  assert.equal(verifyWebhook(raw + ' ', signature, ts, pub), false);
  assert.equal(verifyWebhook(raw, signature, ts, pub, Number(ts) + 121), false);
  assert.equal(verifyWebhook(raw, signature, 'nonsense', pub), false);
});

test('hybrid injected transport preserves one active target and signed webhook is applied once', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519'),
    pub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
  const settings = config({
    ON_EXECUTION_MODE: 'hybrid',
    TELNYX_API_KEY: 'demo-key',
    TELNYX_APPLICATION_ID: 'demo-app',
    CALLER_NUMBER: '+' + '1'.repeat(12),
    PUBLIC_BASE_URL: 'https://example.invalid',
    TELNYX_PUBLIC_KEY: pub,
    ON_OPERATOR_TOKEN: 't'.repeat(32),
    REAL_RESIDENT_E164: '+' + '2'.repeat(12),
    REAL_RESIDENT_CONSENT: 'yes',
  });
  let dials = 0;
  const { app } = await createApp({
    settings,
    port: {
      dial: async (r) => {
        dials++;
        return {
          providerId: 'TEST-CONTROL',
          requestId: r.requestId,
          status: 'initiated',
          mode: 'telnyx',
        };
      },
      hangup: async () => {},
    },
  });
  const headers = { authorization: 'Bearer ' + 't'.repeat(32) };
  try {
    assert.equal(
      (await app.inject({ method: 'POST', url: '/api/command', payload: { action: 'watch' } }))
        .statusCode,
      401,
    );
    await app.inject({
      method: 'POST',
      url: '/api/command',
      headers,
      payload: { action: 'scenario', input: { id: 'active' } },
    });
    let v = (await app.inject('/api/state')).json();
    const dial = await app.inject({
      method: 'POST',
      url: '/api/telephony/dial',
      headers,
      payload: { targetId: 'H012', targetType: 'resident', consent: true, revision: v.revision },
    });
    assert.equal(dial.statusCode, 200);
    v = (await app.inject('/api/state')).json();
    assert.equal(
      v.calls.filter((c: any) => c.mode === 'telnyx' && c.phase === 'calling').length,
      1,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/telephony/dial',
          headers,
          payload: {
            targetId: 'H012',
            targetType: 'resident',
            consent: true,
            revision: v.revision,
          },
        })
      ).statusCode,
      409,
    );
    assert.equal(dials, 1);
    const raw = JSON.stringify({
        data: {
          id: 'END-1',
          event_type: 'call.hangup',
          payload: { call_control_id: 'TEST-CONTROL' },
        },
      }),
      ts = String(Math.floor(Date.now() / 1000)),
      sig = sign(null, Buffer.from(`${ts}|${raw}`), privateKey).toString('base64');
    const webhook = () =>
      app.inject({
        method: 'POST',
        url: '/api/telnyx/webhook',
        headers: {
          'content-type': 'application/json',
          'telnyx-timestamp': ts,
          'telnyx-signature-ed25519': sig,
        },
        payload: raw,
      });
    assert.equal((await webhook()).statusCode, 200);
    assert.equal((await webhook()).json().duplicate, true);
    v = (await app.inject('/api/state')).json();
    assert.equal(v.calls.find((c: any) => c.mode === 'telnyx').phase, 'finished');
    assert.notEqual(
      v.scenario.householdStatuses.find((s: any) => s.householdId === 'H012').status,
      'safe',
    );
  } finally {
    await app.close();
  }
});
