import { test, expect } from '@playwright/test';
import type { View } from '../../shared/src/runtime.ts';
import { handover, tally } from '../../shared/src/domain.ts';

test('real HTTP server and React share one fire-to-handover clock and a frozen report', async ({
  page,
  request,
  baseURL,
}, testInfo) => {
  const external: string[] = [];
  page.on('request', (r) => {
    if (new URL(r.url()).origin !== new URL(baseURL!).origin)
      external.push(r.url());
  });
  const state = async (): Promise<View> => {
    const response = await request.get('/api/state');
    expect(response.ok()).toBe(true);
    expect(response.headers()['x-onmaul-instance']).toBeTruthy();
    return response.json();
  };

  await page.goto('/');
  await expect(page.getByText('서버 연결', { exact: true })).toBeVisible();
  await page.getByTestId('cycle-start').click();
  await expect(page.getByTestId('cycle-phase')).toHaveAttribute(
    'data-phase',
    'review',
  );
  const reviewed = await state();
  expect(reviewed.calls).toHaveLength(0);
  expect(reviewed.plan?.confirmed).toBe(false);
  expect(
    reviewed.graphRuns.some(
      (run) => run.waiting && run.planId === reviewed.plan?.id,
    ),
  ).toBe(true);
  await page
    .getByRole('button', { name: '확정하고 모의 발신 시작', exact: true })
    .click();
  await expect(page.getByTestId('cycle-phase')).toHaveAttribute(
    'data-phase',
    'running',
  );
  await page.getByLabel('시연 배속', { exact: true }).selectOption('60');
  await expect.poll(async () => (await state()).simMinutes).toBeGreaterThan(1);

  await page
    .getByRole('button', { name: '시연 일시정지', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: '시연 재생', exact: true }),
  ).toBeVisible();
  const paused = await state();
  await page.waitForTimeout(750);
  const stillPaused = await state();
  expect(stillPaused.simMinutes).toBe(paused.simMinutes);
  expect(stillPaused.simulation.playing).toBe(false);
  await expect(page.getByTestId('cycle-time')).toContainText(
    `T+${Math.floor(paused.simMinutes)}`,
  );
  await page.screenshot({
    path: testInfo.outputPath('server-cycle-paused.png'),
  });
  await page.getByRole('button', { name: '시연 재생', exact: true }).click();

  await expect(page.getByTestId('cycle-phase')).toHaveAttribute(
    'data-phase',
    'awaiting_handover',
    {
      timeout: 50_000,
    },
  );
  const ready = await state();
  expect(ready.simMinutes).toBeLessThanOrEqual(40);
  expect(ready.simulation.playing).toBe(false);
  expect(ready.frozen).toBe(false);
  await page.screenshot({
    path: testInfo.outputPath('server-cycle-handover.png'),
  });
  expect(ready.firstPass?.targets).toHaveLength(45);
  expect(ready.completedTrips.length).toBeGreaterThan(0);
  expect(ready.shelterAdmissions.length).toBeGreaterThan(0);
  expect(ready.demonstration?.story).toBe('grandfather');
  expect(ready.demonstration?.stage).toBe('completed');
  expect(
    ready.shelterAdmissions.some(
      (admission) => admission.householdId === 'H012',
    ),
  ).toBe(true);
  expect(
    ready.completedTrips.some(
      (trip) => trip.householdId === 'H012' && trip.vehicleId === 'V01',
    ),
  ).toBe(true);
  expect(
    ready.demonstration?.messages.some(
      (message) => message.speaker === 'resident' && /다리/.test(message.text),
    ),
  ).toBe(true);
  await expect(page.getByTestId('demo-story-card')).toContainText('반영환');
  await expect(page.getByTestId('demo-story-card')).toContainText('대피 완료');
  await expect(page.getByTestId('demo-story-card')).toContainText('다리');
  expect(ready.sourceState.actualModelCalls).toBe(0);
  expect(ready.calls.filter((c) => c.mode === 'telnyx')).toHaveLength(0);
  expect(ready.scenario.counts).toEqual(
    tally(ready.data.households, ready.scenario.householdStatuses),
  );
  expect(
    handover(ready.data.households, ready.scenario).length,
  ).toBeGreaterThan(0);
  await expect(page.locator('.situation')).toContainText(
    `안전 ${ready.scenario.counts.safe}/45`,
  );
  await page
    .getByRole('button', { name: '기록으로 종료', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toContainText(
    `미해결 ${handover(ready.data.households, ready.scenario).length}건`,
  );
  await page
    .getByRole('button', {
      name: '인수인계 확인·종료 스냅샷 저장',
      exact: true,
    })
    .click();
  await expect(page.getByTestId('cycle-phase')).toHaveAttribute(
    'data-phase',
    'ended',
  );
  const report = await state();
  expect(report.frozen).toBe(true);
  await page.waitForTimeout(750);
  expect(await state()).toEqual(report);
  const exported = await request.get('/api/export.json');
  expect(await exported.json()).toEqual(report);
  expect(external).toEqual([]);
});

test('squad story shows the named member accepting, moving and completing the grandmother rescue', async ({
  page,
  request,
}) => {
  const state = async (): Promise<View> =>
    (await request.get('/api/state')).json();
  await page.goto('/');
  await expect(page.getByText('서버 연결', { exact: true })).toBeVisible();
  await page.getByLabel('메인 시연', { exact: true }).selectOption('squad');
  await page.getByTestId('cycle-start').click();
  await expect(page.getByTestId('demo-story-card')).toContainText('박미숙');
  await expect(page.getByTestId('demo-resident-marker')).toBeVisible();
  await page
    .getByRole('button', { name: '확정하고 모의 발신 시작', exact: true })
    .click();
  await page.getByLabel('시연 배속', { exact: true }).selectOption('60');
  await expect(page.getByTestId('demo-vehicle')).toBeVisible({
    timeout: 15_000,
  });
  const vehicle = page.getByTestId('demo-vehicle');
  const startX = await vehicle.getAttribute('data-x');
  const startY = await vehicle.getAttribute('data-y');
  await expect
    .poll(
      async () => {
        const movedX = await vehicle.getAttribute('data-x');
        const movedY = await vehicle.getAttribute('data-y');
        return movedX !== startX || movedY !== startY;
      },
      { timeout: 5_000 },
    )
    .toBe(true);
  await expect(page.getByTestId('demo-member-status')).toContainText('구조 중');
  await expect(page.getByTestId('demo-story-card')).toHaveAttribute(
    'data-stage',
    'evacuating',
    {
      timeout: 10_000,
    },
  );
  await expect(page.getByTestId('demo-stage')).toContainText('구조 중');
  await expect(page.getByTestId('demo-story-card')).toHaveAttribute(
    'data-stage',
    'completed',
    {
      timeout: 20_000,
    },
  );
  await expect(page.getByTestId('demo-member-status')).toContainText(
    '구조 완료',
  );
  const completed = await state();
  expect(completed.demonstration?.story).toBe('squad');
  expect(completed.demonstration?.memberId).toBe('M01');
  expect(completed.memberResponses.M01).toBe('ok');
  expect(
    completed.shelterAdmissions.some(
      (admission) => admission.householdId === 'H009',
    ),
  ).toBe(true);
  expect(
    completed.demonstration?.messages.some(
      (message) => message.speaker === 'member' && /가능/.test(message.text),
    ),
  ).toBe(true);
  expect(completed.sourceState.actualModelCalls).toBe(0);
  await page
    .getByRole('button', { name: '기록으로 종료', exact: true })
    .click();
  await page
    .getByRole('button', {
      name: '인수인계 확인·종료 스냅샷 저장',
      exact: true,
    })
    .click();
  await expect(page.getByTestId('cycle-phase')).toHaveAttribute(
    'data-phase',
    'ended',
  );
});
