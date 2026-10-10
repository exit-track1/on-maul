import { expect, test } from '@playwright/test';
import { enterSimulation, prepareSimulation } from './helpers/presentation';

test('deployed-style dashboard plays a private session with no token or API polling', async ({
  page,
  baseURL,
}) => {
  const requests: string[] = [],
    errors: string[] = [];
  page.on('request', (req) => requests.push(req.url()));
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await enterSimulation(page);
  await expect(page.getByText('개별 세션 재생', { exact: true })).toBeVisible();
  await expect(page.getByTestId('resident-phone')).toContainText(
    '반영환 할아버지',
  );
  await expect(page.getByTestId('demo-resident-marker')).toContainText(
    '반영환 할아버지',
  );
  await expect(page.getByRole('img', { name: /48가구/ })).toContainText(
    '박미숙 할머니',
  );
  await expect(
    page.getByLabel('시뮬레이션 재생 현황').locator('button, input, select'),
  ).toHaveCount(0);
  const at = await page.getByTestId('simulation-time').textContent();
  await expect(page.getByTestId('simulation-time')).not.toHaveText(at!);
  await expect(page.getByTestId('trip-vehicle').first()).toBeVisible({
    timeout: 15000,
  });
  expect(
    requests.every((url) => new URL(url).origin === new URL(baseURL!).origin),
  ).toBe(true);
  expect(
    requests.some((url) =>
      /\/api\/(phone|telephony)|webhooks|openai|telnyx/.test(url),
    ),
  ).toBe(false);
  expect(errors).toEqual([]);
  expect(
    requests.some((url) => new URL(url).pathname.startsWith('/api/')),
  ).toBe(false);
});

test('visitors and tabs sharing an IP and cookies start at zero without changing other playbacks', async ({
  page,
  context,
  browser,
  baseURL,
}) => {
  await page.clock.install({ time: new Date('2026-01-01') });
  await page.goto('/');
  await prepareSimulation(page);
  await page.clock.pauseAt(new Date('2030-01-01'));
  await page
    .getByRole('button', { name: '시뮬레이션 보기 →', exact: true })
    .click();
  await expect(page.getByTestId('simulation-time')).toHaveText('T+0.0분');
  const firstId = await page.locator('main').getAttribute('data-session-id');
  expect(firstId).toMatch(/^[0-9a-f-]{36}$/);
  await page.clock.fastForward(20000);
  await expect(page.getByTestId('simulation-time')).toHaveText('T+10.0분');

  const second = await context.newPage();
  await second.goto('/');
  await prepareSimulation(second);
  await page.clock.fastForward(40000);
  await second
    .getByRole('button', { name: '시뮬레이션 보기 →', exact: true })
    .click();
  await expect(second.getByTestId('simulation-time')).toHaveText('T+0.0분');
  const secondId = await second.locator('main').getAttribute('data-session-id');
  expect(secondId).not.toBe(firstId);
  await expect(page.getByTestId('simulation-time')).toHaveText('T+30.0분');
  await page.clock.fastForward(4000);
  await expect(page.getByTestId('simulation-time')).toHaveText('T+32.0분');
  await expect(second.getByTestId('simulation-time')).toHaveText('T+2.0분');

  const otherContext = await browser.newContext({ baseURL });
  try {
    const third = await otherContext.newPage();
    await third.clock.install({ time: new Date('2026-01-01') });
    await third.goto('/');
    await prepareSimulation(third);
    await third.clock.pauseAt(new Date('2030-01-01'));
    await third
      .getByRole('button', { name: '시뮬레이션 보기 →', exact: true })
      .click();
    await expect(third.getByTestId('simulation-time')).toHaveText('T+0.0분');
    const thirdId = await third.locator('main').getAttribute('data-session-id');
    expect(thirdId).not.toBe(firstId);
    expect(thirdId).not.toBe(secondId);
    await third.clock.fastForward(6000);
    await expect(third.getByTestId('simulation-time')).toHaveText('T+3.0분');
    await expect(page.getByTestId('simulation-time')).toHaveText('T+32.0분');
    await second.reload();
    await enterSimulation(second);
    await expect(second.getByTestId('simulation-time')).toHaveText('T+0.0분');
    expect(
      await second.locator('main').getAttribute('data-session-id'),
    ).not.toBe(secondId);
    await expect(page.getByTestId('simulation-time')).toHaveText('T+32.0분');
    await page.clock.fastForward(500000);
    await expect(page.locator('.showcase-cycle strong')).not.toContainText(
      '1회차',
    );
    await expect(page.getByTestId('playback-status')).toHaveText(
      '30배속 · 자동 반복 재생',
    );
  } finally {
    await otherContext.close();
    await second.close();
  }
});
