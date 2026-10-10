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
test('unauthenticated simulation controls pause, resume and clear all old results', async (t) => {
  let milliseconds = 0;
  const { app, runtime } = await createApp({
    seed: 10,
    simulation: { now: () => milliseconds, timer },
  });
  t.after(() => app.close());
  milliseconds = 6000;
  let response = await app.inject({
    method: 'POST',
    url: '/api/command',
    payload: { action: 'sim', input: { playing: false } },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().simMinutes, 3);
  assert.ok(response.json().showcase.calls.some((c: { turns: unknown[] }) => c.turns.length > 1));
  milliseconds += 60000;
  response = await app.inject({
    method: 'POST',
    url: '/api/command',
    payload: { action: 'demo-reset' },
  });
  assert.equal(response.json().simMinutes, 0);
  assert.deepEqual(response.json().showcase.calls, []);
  assert.equal(runtime.view().simulation.playing, false);
  response = await app.inject({
    method: 'POST',
    url: '/api/command',
    payload: { action: 'sim', input: { playing: true, speed: 60 } },
  });
  assert.equal(response.json().showcase.calls.length, 2);
  response = await app.inject({
    method: 'POST',
    url: '/api/command',
    payload: { action: 'dial', input: {} },
  });
  assert.equal(response.statusCode, 400);
});
