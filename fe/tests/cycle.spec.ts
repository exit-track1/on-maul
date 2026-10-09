import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import type { View } from '../../shared/src/runtime.ts';

test('offline main cycle stays live-only and blocked without calling or falling back to mock', async ({
  page,
  baseURL,
}) => {
  const apiRequests: string[] = [];
  const external: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/')) apiRequests.push(url.pathname);
    if (url.origin !== new URL(baseURL!).origin) external.push(url.origin);
  });
  await page.clock.install();
  await page.goto('/index.html?demo=1');
  await expect(page.getByLabel('전화 모드', { exact: true })).toHaveCount(0);
  await expect(page.getByTestId('cycle-start')).toBeDisabled();
  await expect(
    page.getByText('서버 연결 필요 · 실제 전화 시작 불가', { exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId('demo-resident-marker')).toBeVisible();
  await page.clock.runFor(60_000);
  await expect(page.getByTestId('cycle-phase')).toHaveAttribute(
    'data-phase',
    'idle',
  );
  await expect(page.getByTestId('cycle-time')).toContainText('T+0분');
  await page.getByRole('tab', { name: '통화 내역', exact: true }).click();
  const history = page.getByTestId('call-history');
  await expect(
    history.getByRole('button', { name: '반영환 할아버지', exact: false }),
  ).toBeVisible();
  await expect(
    history.getByRole('button', { name: '반영환 대원', exact: false }),
  ).toBeVisible();
  await expect(
    history.getByRole('button', { name: '박미숙 할머니', exact: false }),
  ).toHaveCount(0);
  await expect(history).toContainText('실제 통화 내역이 없습니다');
  await page.getByRole('tab', { name: '기록', exact: true }).click();
  const completed = page.waitForEvent('download');
  await page
    .getByRole('button', { name: 'JSON 내보내기', exact: true })
    .click();
  const download = await completed;
  const report = JSON.parse(
    await readFile((await download.path())!, 'utf8'),
  ) as View;
  expect(report.calls).toEqual([]);
  expect(report.demonstration).toBeNull();
  expect(report.sourceState.actualModelCalls).toBe(0);
  expect(apiRequests).toEqual([]);
  expect(external).toEqual([]);
});
