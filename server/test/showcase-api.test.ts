import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.ts';

const timer = { setInterval: () => 0, clearInterval: () => {} };
test('legacy keys and hybrid settings cannot cause any external request or expose a token', async (t) => {
  const saved = { ...process.env };
  const fetch = globalThis.fetch;
  let attempts = 0;
  process.env.ON_EXECUTION_MODE = 'hybrid';
  process.env.ON_PHONE_ENABLED = 'yes';
  process.env.OPENAI_API_KEY = 'unused-key';
  process.env.TELNYX_API_KEY = 'unused-key';
  process.env.ON_OPERATOR_TOKEN = 'unused-token';
  globalThis.fetch = async () => {
    attempts++;
    throw new Error('outbound network forbidden');
  };
  t.after(() => {
    globalThis.fetch = fetch;
    process.env = saved;
  });
  const { app, runtime } = await createApp({ seed: 42, simulation: { now: () => 0, timer } });
  t.after(() => app.close());
  const health = (await app.inject('/api/health')).json();
  assert.equal(health.mode, 'demo');
  assert.equal(health.externalCalls, false);
  assert.equal(health.phoneEnabled, false);
  assert.equal((await app.inject('/api/state')).statusCode, 200);
  for (const path of [
    '/api/phone/bootstrap',
    '/api/phone/state',
    '/api/phone/dial',
    '/api/telephony/dial',
    '/webhooks/telnyx',
    '/media/abcdef',
    '/probe/abc',
  ]) {
    const response = await app.inject({
      method: path.endsWith('dial') || path.startsWith('/webhooks') ? 'POST' : 'GET',
      url: path,
      payload: path.endsWith('dial') ? {} : undefined,
    });
    assert.equal(response.statusCode, 410, path);
    assert.ok(!response.body.includes('unused-token'));
  }
  runtime.command('sim', { autoRepeat: false });
  runtime.tickCycle(200);
  assert.equal(runtime.view().scenario.counts.safe, 48);
  assert.equal(attempts, 0);
});
test('visitors cannot mutate playback, and rejected commands never stop the shared clock', async (t) => {
  let milliseconds = 0;
  const { app, runtime, simulation } = await createApp({
    seed: 10,
    simulation: { now: () => milliseconds, timer },
  });
  t.after(() => app.close());
  milliseconds = 6000;
  const before = runtime.view();
  for (const payload of [
    { action: 'sim', input: { playing: false } },
    { action: 'sim', input: { speed: 60 } },
    { action: 'sim', input: { autoRepeat: false } },
    { action: 'demo-reset' },
    { action: 'showcase-restart' },
    { action: 'showcase-play', input: { playing: false } },
    { action: 'showcase-focus', input: { role: 'resident', callId: null } },
    { action: 'dial' },
  ]) {
    const response = await app.inject({ method: 'POST', url: '/api/command', payload });
    assert.equal(response.statusCode, 403, payload.action);
    assert.equal(response.json().code, 'read_only_playback');
    assert.deepEqual(runtime.view(), before);
  }
  await simulation.pulse();
  assert.equal(runtime.view().simMinutes, 3);
  milliseconds += 60000;
  await simulation.pulse();
  const view = (await app.inject('/api/state')).json();
  assert.equal(view.simMinutes, 33);
  assert.equal(view.simulation.playing, true);
  assert.equal(view.simulation.speed, 30);
  assert.equal(view.showcase.autoRepeat, true);
});
