import test from 'node:test';
import assert from 'node:assert/strict';
import { publicProbe } from '../src/public-probe.ts';

test('공개 콜백은 현재 서버 토큰을 확인하고 API 키 없는 GET만 보냄', async () => {
  let request: any;
  const result = await publicProbe(
    'https://callback.example.com',
    'current-token',
    async (url, options) => {
      request = { url: String(url), options };
      return Response.json({ onCallback: 'current-token' });
    },
  );
  assert.equal(result.ok, true);
  assert.equal(request.url, 'https://callback.example.com/probe/current-token');
  assert.equal(request.options.redirect, 'error');
  assert.ok(!request.options.headers.Authorization);
});
test('HTTP 503·다른 서버 토큰·HTML 응답을 구분하고 URL 없음은 요청하지 않음', async () => {
  await assert.rejects(
    publicProbe(
      'https://callback.example.com',
      'current-token',
      async () => new Response('unavailable', { status: 503 }),
    ),
    /HTTP 503/,
  );
  await assert.rejects(
    publicProbe('https://callback.example.com', 'current-token', async () =>
      Response.json({ onCallback: 'different-server' }),
    ),
    /토큰이 다릅니다/,
  );
  await assert.rejects(
    publicProbe(
      'https://callback.example.com',
      'current-token',
      async () => new Response('<html>website</html>'),
    ),
    /콜백 JSON/,
  );
  let requests = 0;
  await assert.rejects(
    publicProbe('', 'token', async () => {
      requests++;
      throw new Error('should not fetch');
    }),
    /공개 콜백 URL/,
  );
  assert.equal(requests, 0);
});
