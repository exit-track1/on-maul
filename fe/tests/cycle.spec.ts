import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import type { View } from '../../shared/src/runtime.ts';

async function exportReport(page: Page): Promise<View> {
  const completed = page.waitForEvent('download');
  await page
    .getByRole('button', { name: 'JSON 내보내기', exact: true })
    .click();
  const download = await completed;
  return JSON.parse(await readFile((await download.path())!, 'utf8')) as View;
}

test('offline fire cycle waits for human decisions, shares playback clock and freezes its handover without API calls', async ({
  page,
  baseURL,
}) => {
  const apiRequests: string[] = [];
  const external: string[] = [];
  const errors: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/')) apiRequests.push(request.url());
    if (url.origin !== new URL(baseURL!).origin) external.push(request.url());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.clock.install();
  await page.goto('/index.html?demo=1');
  await expect(page.getByTestId('demo-story-card')).toHaveCount(0);
  await expect(page.getByTestId('demo-resident-marker')).toBeVisible();
  const plannedHome = page
    .getByTestId('demo-resident-marker')
    .getByTestId('household-marker');
  const plannedX = await plannedHome.getAttribute('cx');
  const plannedY = await plannedHome.getAttribute('cy');
  await page.getByTestId('cycle-start').click();
  await expect(page.getByTestId('demo-resident-marker')).toHaveAttribute(
    'aria-label',
    /H012 반영환 할아버지/,
  );
  await expect(page.getByTestId('cycle-phase')).toHaveAttribute(
    'data-phase',
    'review',
  );
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(plannedHome).toHaveAttribute('cx', plannedX!);
  await expect(plannedHome).toHaveAttribute('cy', plannedY!);
  await page.clock.runFor(2000);
  await expect(page.getByTestId('cycle-time')).toContainText('T+0분');
  await page
    .getByRole('button', { name: '확정하고 모의 발신 시작', exact: true })
    .click();
  await expect(page.getByTestId('cycle-phase')).toHaveAttribute(
    'data-phase',
    'running',
  );
  await expect(page.getByLabel('미리보기 시간', { exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByTestId('map-cycle-clock')).toBeVisible();
  await page.clock.runFor(2200);
  await expect(page.getByTestId('cycle-time')).toContainText('T+1분');
  await page
    .getByRole('button', { name: '시연 일시정지', exact: true })
    .click();
  const pausedTime = await page.getByTestId('cycle-time').innerText();
  const pausedCounts = await page.locator('.situation-counts').innerText();
  const pausedFire = await page.getByTestId('fire-perimeter').getAttribute('d');
  await page.clock.runFor(3000);
  await expect(page.getByTestId('cycle-time')).toHaveText(pausedTime, {
    useInnerText: true,
  });
  await expect(page.locator('.situation-counts')).toHaveText(pausedCounts, {
    useInnerText: true,
  });
  await expect(page.getByTestId('fire-perimeter')).toHaveAttribute(
    'd',
    pausedFire!,
  );
  await page.getByLabel('시연 배속', { exact: true }).selectOption('12');
  await expect(page.getByLabel('시연 배속', { exact: true })).toHaveValue('12');
  await page.getByRole('button', { name: '시연 재생', exact: true }).click();
  await page.clock.runFor(500);
  await page
    .getByRole('button', { name: '시연 일시정지', exact: true })
    .click();
  await page.getByLabel('시연 배속', { exact: true }).selectOption('60');
  await page.getByRole('button', { name: '시연 재생', exact: true }).click();
  await page.clock.fastForward(40_000);
  await expect(page.getByTestId('cycle-phase')).toHaveAttribute(
    'data-phase',
    'awaiting_handover',
  );
  const finalMinute = Number(
    await page.getByTestId('cycle-progress').getAttribute('value'),
  );
  expect(finalMinute).toBeGreaterThan(0);
  expect(finalMinute).toBeLessThanOrEqual(40);
  await expect(page.getByTestId('cycle-time')).toContainText(
    `T+${Math.floor(finalMinute)}분`,
  );
  await expect(
    page.getByRole('button', { name: '시연 재생', exact: true }),
  ).toBeDisabled();
  await page
    .getByRole('button', { name: '기록으로 종료', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toContainText('미해결');
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
  const report = await exportReport(page);
  expect(report.frozen).toBe(true);
  expect(report.simMinutes).toBe(finalMinute);
  expect(report.simulation.playing).toBe(false);
  expect(report.scenario.counts.total).toBe(48);
  expect(report.calls.filter((call) => call.mode === 'telnyx')).toHaveLength(0);
  expect(report.sourceState.actualModelCalls).toBe(0);
  await page.clock.fastForward(60_000);
  expect(await exportReport(page)).toEqual(report);
  expect(apiRequests).toEqual([]);
  expect(external).toEqual([]);
  expect(errors).toEqual([]);
});
