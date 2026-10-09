import { expect, test, type Page } from '@playwright/test';
import { Runtime } from '../../shared/src/runtime.ts';
import type { PhoneCall, PhoneState } from '../../shared/src/phone.ts';

const unexpectedRequests = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page, baseURL }) => {
  const unexpected: string[] = [];
  unexpectedRequests.set(page, unexpected);
  const fixtureOrigin = new URL(baseURL!).origin;
  // Later per-test routes override these defaults. Every API response must be
  // a fixture, so Vite's /api proxy can never reach the operator's local server.
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== fixtureOrigin || url.pathname.startsWith('/api/')) {
      unexpected.push(`${route.request().method()} ${url.pathname}`);
      await route.abort('blockedbyclient');
    } else {
      await route.continue();
    }
  });
  await page.route('**/api/phone/bootstrap', (route) =>
    route.fulfill({ json: { enabled: false, token: '' } }),
  );
});

test.afterEach(async ({ page }) => {
  expect(unexpectedRequests.get(page)).toEqual([]);
});

for (const actor of [
  {
    id: 'H012' as const,
    name: '반영환 할아버지',
    story: 'grandfather',
    moving: '대피 중',
    completed: '대피 완료',
  },
  {
    id: 'H009' as const,
    name: '박미숙 할머니',
    story: 'squad',
    moving: '구조 중',
    completed: '대피 완료',
  },
  {
    id: 'M01' as const,
    name: '반영환 대원',
    story: 'squad',
    moving: '구조 중',
    completed: '구조 완료',
  },
])
  test(`${actor.name} current call shows rescue progress while an earlier call keeps its original record`, async ({
    page,
  }) => {
    const runtime = new Runtime();
    runtime.command('cycle-start', {
      revision: runtime.view().revision,
      demoStory: actor.story,
      phoneMode: 'live',
    });
    runtime.command('confirm', { revision: runtime.view().revision });
    const call = fixtureCall(actor.id);
    const residentId = actor.story === 'grandfather' ? 'H012' : 'H009';
    runtime.preparePhoneCall(
      residentId,
      call.requestId,
      runtime.view().revision,
    );
    const view = runtime.view();
    if (actor.id === 'M01') {
      const prepared = view.calls.find((entry) => entry.id === call.requestId)!;
      prepared.targetId = 'M01';
      prepared.targetType = 'member';
    }
    view.demonstration!.stage = 'evacuating';
    call.status = 'ended';
    call.endedAt = call.answeredAt! + 30_000;
    const earlier = {
      ...call,
      id: 'EARLIER-SESSION',
      requestId: 'EARLIER-REQUEST',
      requestedAt: call.requestedAt! - 60_000,
    };
    const phone = configuredPhone();
    phone.calls = [call, earlier];
    await page.route('**/api/phone/bootstrap', (route) =>
      route.fulfill({ json: { enabled: true, token: 'fixture-progress' } }),
    );
    await page.route('**/api/state', (route) => route.fulfill({ json: view }));
    await page.route('**/api/phone/state', (route) =>
      route.fulfill({ json: phone }),
    );
    await page.goto('/');
    await page.getByRole('tab', { name: '통화 내역', exact: true }).click();
    const history = page.getByTestId('call-history');
    await history
      .getByRole('button', { name: actor.name, exact: false })
      .click();
    await expect(history.getByTestId('call-business-status')).toHaveText(
      actor.moving,
    );
    view.demonstration!.stage = 'completed';
    view.revision++;
    await expect(history.getByTestId('call-business-status')).toHaveText(
      actor.completed,
    );
    await history
      .getByLabel('통화 기록', { exact: true })
      .selectOption(earlier.id);
    await expect(history.getByTestId('call-business-status')).toHaveCount(0);
  });

test('newest call is shown first while an earlier call remains selectable', async ({
  page,
}) => {
  const runtime = new Runtime();
  runtime.command('cycle-start', {
    revision: runtime.view().revision,
    demoStory: 'grandfather',
    phoneMode: 'live',
  });
  runtime.command('confirm', { revision: runtime.view().revision });
  const phone = configuredPhone();
  const newest = fixtureCall();
  newest.transcript = [{ speaker: 'user', text: '새 통화 답변입니다.' }];
  const earlier = {
    ...fixtureCall(),
    id: 'SESSION-EARLIER',
    requestId: 'REQUEST-EARLIER',
    status: 'ended' as const,
    requestedAt: newest.requestedAt! - 60_000,
    endedAt: newest.requestedAt! - 30_000,
    transcript: [{ speaker: 'user' as const, text: '이전 통화 답변입니다.' }],
  };
  phone.calls = [newest, earlier];
  await page.route('**/api/phone/bootstrap', (route) =>
    route.fulfill({ json: { enabled: true, token: 'fixture-history' } }),
  );
  await page.route('**/api/state', (route) =>
    route.fulfill({ json: runtime.view() }),
  );
  await page.route('**/api/phone/state', (route) =>
    route.fulfill({ json: phone }),
  );
  await page.goto('/');
  await page.getByRole('tab', { name: '통화 내역', exact: true }).click();
  const history = page.getByTestId('call-history');
  await expect(history.getByTestId('actual-call-record')).toHaveAttribute(
    'data-status',
    'answered',
  );
  await expect(history.getByRole('list')).toContainText('새 통화 답변입니다.');
  await expect(history.getByRole('list')).not.toContainText(
    '이전 통화 답변입니다.',
  );
  await history
    .getByLabel('통화 기록', { exact: true })
    .selectOption(earlier.id);
  await expect(history.getByTestId('actual-call-record')).toHaveAttribute(
    'data-status',
    'ended',
  );
  await expect(history.getByRole('list')).toContainText(
    '이전 통화 답변입니다.',
  );
});

test('localhost bootstrap configures bearer reads without putting its token in the visible interface', async ({
  page,
}) => {
  const runtime = new Runtime();
  const phone = configuredPhone();
  const authenticated: string[] = [];
  await page.route('**/api/phone/bootstrap', (route) =>
    route.fulfill({ json: { enabled: true, token: 'fixture-local-auto' } }),
  );
  await page.route('**/api/state', async (route) => {
    const authorization = route.request().headers().authorization ?? '';
    authenticated.push(authorization);
    await route.fulfill(
      authorization === 'Bearer fixture-local-auto'
        ? { json: runtime.view() }
        : { status: 401, json: { error: '인증 필요' } },
    );
  });
  await page.route('**/api/phone/state', async (route) => {
    const authorization = route.request().headers().authorization ?? '';
    authenticated.push(authorization);
    await route.fulfill(
      authorization === 'Bearer fixture-local-auto'
        ? { json: phone }
        : { status: 401, json: { error: '인증 필요' } },
    );
  });
  await page.goto('/');
  await expect(page.getByText('서버 연결', { exact: true })).toBeVisible();
  await expect(
    page
      .getByLabel('전화 모드', { exact: true })
      .locator('option[value="live"]'),
  ).not.toHaveAttribute('disabled');
  await expect(page.locator('body')).not.toContainText('fixture-local-auto');
  await expect(page.getByLabel('운영자 토큰', { exact: true })).toHaveValue('');
  expect(authenticated.length).toBeGreaterThanOrEqual(2);
  expect(
    authenticated.every(
      (authorization) => authorization === 'Bearer fixture-local-auto',
    ),
  ).toBe(true);
});

function configuredPhone(): PhoneState {
  return {
    enabled: true,
    ready: true,
    busy: false,
    notice: '실제 전화 연결 준비 완료',
    targets: [
      {
        id: 'H012',
        name: '반영환 할아버지',
        scenario: 'resident',
        configured: true,
        phoneMasked: '010-****-0012',
        consent: true,
      },
      {
        id: 'H009',
        name: '박미숙 할머니',
        scenario: 'resident',
        configured: true,
        phoneMasked: '010-****-0009',
        consent: true,
      },
      {
        id: 'M01',
        name: '반영환 대원',
        scenario: 'standby',
        configured: true,
        phoneMasked: '010-****-0001',
        consent: true,
      },
    ],
    calls: [],
  };
}

function fixtureCall(targetId: 'H012' | 'H009' | 'M01' = 'H012'): PhoneCall {
  return {
    id: `SESSION-${targetId}`,
    requestId: `REQUEST-${targetId}`,
    targetId,
    targetName:
      targetId === 'H012'
        ? '반영환 할아버지'
        : targetId === 'H009'
          ? '박미숙 할머니'
          : '반영환 대원',
    scenario: targetId === 'M01' ? 'standby' : 'resident',
    providerId: null,
    status: 'answered',
    blocked: false,
    requestedAt: 1_791_523_800_000,
    answeredAt: 1_791_523_803_000,
    endedAt: null,
    transcript: [
      {
        speaker: 'assistant',
        text: '산불로 인해 대피하셔야 합니다. 온빛 배움학교로 이동 가능하십니까?',
      },
      {
        speaker: 'user',
        text: '지금 움직이기 어려워요. 차 보내주실 수 있나요?',
      },
    ],
    notice: '',
  };
}

async function enterToken(page: Page) {
  await page.getByText('전화 연결 설정', { exact: true }).click();
  await page
    .getByLabel('운영자 토큰', { exact: true })
    .fill('fixture-operator');
  await page
    .getByRole('button', { name: '연결 설정 적용', exact: true })
    .click();
  await expect(
    page
      .getByLabel('전화 모드', { exact: true })
      .locator('option[value="live"]'),
  ).not.toHaveAttribute('disabled');
  await page.getByText('전화 연결 설정', { exact: true }).click();
}

test('call history shows actual records only, keeps the map on the right and makes no phone requests offline', async ({
  page,
}) => {
  const api: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/'))
      api.push(request.url());
  });
  await page.clock.install();
  await page.goto('/index.html?demo=1');
  await expect(
    page.getByLabel('전화 모드').locator('option[value="live"]'),
  ).toHaveAttribute('disabled', '');
  await page.getByTestId('cycle-start').click();
  await page
    .getByRole('button', { name: '확정하고 모의 발신 시작', exact: true })
    .click();
  await page.clock.runFor(2200);
  await page.getByRole('tab', { name: '통화 내역', exact: true }).click();
  const history = page.getByTestId('call-history');
  await expect(history).toContainText('실제 전화 전사');
  await expect(history).toContainText('실제 통화 내역이 없습니다');
  await expect(history).not.toContainText('합성 모의');
  await expect(
    history.getByRole('button', { name: '모의 통화', exact: true }),
  ).toHaveCount(0);
  await expect(
    history.getByRole('button', { name: '실제 전화', exact: true }),
  ).toHaveCount(0);
  await expect(history.getByRole('list')).toHaveCount(0);
  await expect(page.getByTestId('demo-story-card')).toHaveCount(0);
  await expect(page.getByTestId('household-marker')).toHaveCount(48);
  const left = await history.boundingBox();
  const right = await page.locator('.map-wrap').boundingBox();
  expect(left).not.toBeNull();
  expect(right).not.toBeNull();
  expect(right!.x).toBeGreaterThan(left!.x + left!.width);
  await expect(
    history.getByRole('button', { name: '실제 전화 걸기', exact: true }),
  ).toBeDisabled();
  expect(api).toEqual([]);
});

test('real mode requires operator setup and explicit consent, then shows polled speech and its evidence', async ({
  page,
}) => {
  const runtime = new Runtime();
  const phone = configuredPhone();
  const commands: {
    action: string;
    input: Record<string, unknown>;
    authorization?: string;
  }[] = [];
  const phoneReads: string[] = [];
  await page.route('**/api/state', (route) =>
    route.fulfill({
      json: runtime.view(),
      headers: { 'x-onmaul-instance': 'phone-fixture' },
    }),
  );
  await page.route('**/api/phone/state', async (route) => {
    const authorization = route.request().headers().authorization ?? '';
    phoneReads.push(authorization);
    await route.fulfill(
      authorization === 'Bearer fixture-operator'
        ? { json: phone }
        : { status: 401, json: { error: '운영자 인증 필요' } },
    );
  });
  await page.route('**/api/command', async (route) => {
    const body = route.request().postDataJSON() as {
      action: string;
      input: Record<string, unknown>;
    };
    commands.push({
      ...body,
      authorization: route.request().headers().authorization,
    });
    runtime.command(body.action, body.input);
    if (body.action === 'confirm') {
      const call = fixtureCall();
      runtime.preparePhoneCall('H012', call.requestId, runtime.view().revision);
      runtime.applyPhoneUpdate(call.requestId, { phase: 'talking' });
      phone.calls.push(call);
      phone.busy = true;
    }
    await route.fulfill({
      json: runtime.view(),
      headers: { 'x-onmaul-instance': 'phone-fixture' },
    });
  });
  await page.goto('/');
  await expect(page.getByText('서버 연결', { exact: true })).toBeVisible();
  expect(phoneReads).toEqual([]);
  await enterToken(page);
  await page.getByLabel('전화 모드', { exact: true }).selectOption('live');
  await expect(page.getByTestId('cycle-start')).toBeDisabled();
  await page
    .getByLabel('선택한 시연 대상의 실제 발신 동의를 확인했습니다', {
      exact: true,
    })
    .check();
  await page.getByTestId('cycle-start').click();
  await expect(page.getByRole('dialog')).toContainText('실제 전화');
  await page
    .getByRole('button', { name: '확정하고 실제 전화 발신', exact: true })
    .click();
  await expect(
    page.getByRole('tab', { name: '통화 내역', exact: true }),
  ).toHaveAttribute('aria-selected', 'true');
  const history = page.getByTestId('call-history');
  await expect(
    history.getByRole('list', { name: '반영환 할아버지 실제 통화 전사' }),
  ).toContainText('차 보내주실');
  await expect(history.getByTestId('actual-call-record')).toHaveAttribute(
    'data-status',
    'answered',
  );
  await expect(page.getByTestId('demo-story-card')).toHaveCount(0);
  await expect(history).not.toContainText('합성 모의');
  await expect(
    page.getByText('실제 통화 종료를 기다립니다', { exact: false }),
  ).toBeVisible();
  expect(commands[0]).toMatchObject({
    action: 'cycle-start',
    input: { phoneMode: 'live', phoneConsent: true },
    authorization: 'Bearer fixture-operator',
  });
  expect(
    phoneReads.every(
      (authorization) => authorization === 'Bearer fixture-operator',
    ),
  ).toBe(true);

  const call = phone.calls[0];
  call.status = 'ended';
  call.endedAt = 1_791_523_830_000;
  call.transcript.push({
    speaker: 'assistant',
    text: '이동 지원 요청을 접수했습니다.',
  });
  call.completion = {
    status: 'reported',
    kind: 'rescue',
    location: '집',
    evidence: '움직이기 어려워요. 차 보내주실 수 있나요?',
    recordedAt: call.endedAt,
    playbackConfirmed: true,
  };
  phone.busy = false;
  await expect(history.getByTestId('actual-call-record')).toHaveAttribute(
    'data-status',
    'ended',
  );
  await expect(history).toContainText('구조 지원 필요');
  await expect(history).toContainText(
    '움직이기 어려워요. 차 보내주실 수 있나요?',
  );
  await expect(history).toContainText('현장 검증 결과가 아닙니다');
  await expect(page.getByTestId('household-marker')).toHaveCount(48);
  await history
    .getByRole('button', { name: '반영환 대원', exact: false })
    .click();
  await expect(history).toContainText('실제 통화 내역이 없습니다');
  await expect(history.getByRole('list')).toHaveCount(0);
});

test('real call controls send authenticated target requests and require a checked operator confirmation to resolve uncertainty', async ({
  page,
}) => {
  const runtime = new Runtime();
  runtime.command('cycle-start', {
    revision: runtime.view().revision,
    demoStory: 'grandfather',
    phoneMode: 'live',
  });
  runtime.command('confirm', { revision: runtime.view().revision });
  const phone = configuredPhone();
  const call = fixtureCall();
  call.status = 'ended';
  call.endedAt = 1_791_523_830_000;
  phone.calls = [call];
  const requests: {
    action: string;
    body: Record<string, unknown>;
    authorization?: string;
  }[] = [];
  await page.route('**/api/state', (route) =>
    route.fulfill({
      json: runtime.view(),
      headers: { 'x-onmaul-instance': 'controls-fixture' },
    }),
  );
  await page.route('**/api/phone/state', (route) =>
    route.fulfill({ json: phone }),
  );
  for (const action of ['dial', 'hangup', 'resolve']) {
    await page.route(`**/api/phone/${action}`, async (route) => {
      requests.push({
        action,
        body: route.request().postDataJSON(),
        authorization: route.request().headers().authorization,
      });
      if (action === 'dial') {
        call.status = 'unknown';
        call.blocked = true;
        phone.busy = true;
      }
      if (action === 'resolve') {
        call.status = 'ended';
        call.blocked = false;
        phone.busy = false;
      }
      await route.fulfill({ json: { phone } });
    });
  }
  await page.goto('/');
  await enterToken(page);
  await page.getByRole('tab', { name: '통화 내역', exact: true }).click();
  const history = page.getByTestId('call-history');
  await expect(
    history.getByRole('button', { name: '실제 전화 다시 걸기', exact: true }),
  ).toBeDisabled();
  await history
    .getByLabel('반영환 할아버지 수신자의 발신 동의를 확인했습니다', {
      exact: true,
    })
    .check();
  await history
    .getByRole('button', { name: '실제 전화 다시 걸기', exact: true })
    .click();
  await expect(history.getByTestId('actual-call-record')).toHaveAttribute(
    'data-status',
    'unknown',
  );
  await expect(
    history.getByRole('button', { name: '종료 확인·진행 재개', exact: true }),
  ).toBeDisabled();
  await history
    .getByRole('button', { name: '통화 종료 요청', exact: true })
    .click();
  await history
    .getByLabel('운영자가 실제 전화 종료를 확인했습니다', { exact: true })
    .check();
  await history
    .getByRole('button', { name: '종료 확인·진행 재개', exact: true })
    .click();
  await expect(history.getByTestId('actual-call-record')).toHaveAttribute(
    'data-status',
    'ended',
  );
  expect(requests).toEqual([
    {
      action: 'dial',
      body: {
        targetId: 'H012',
        consent: true,
        revision: runtime.view().revision,
      },
      authorization: 'Bearer fixture-operator',
    },
    {
      action: 'hangup',
      body: { callId: call.id, revision: runtime.view().revision },
      authorization: 'Bearer fixture-operator',
    },
    {
      action: 'resolve',
      body: {
        callId: call.id,
        confirmedEnded: true,
        revision: runtime.view().revision,
      },
      authorization: 'Bearer fixture-operator',
    },
  ]);
});
