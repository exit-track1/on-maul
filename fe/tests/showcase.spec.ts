import { expect, test } from '@playwright/test';
import { enterSimulation, prepareSimulation } from './helpers/presentation';

test('both phone agents, all residents and local map are visible without external requests', async ({
  page,
  baseURL,
}) => {
  const external: string[] = [],
    errors: string[] = [];
  page.on('request', (req) => {
    if (new URL(req.url()).origin !== new URL(baseURL!).origin)
      external.push(req.url());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/?demo=1');
  await enterSimulation(page);
  await expect(page.getByTestId('resident-phone')).toBeVisible();
  await expect(page.getByTestId('rescuer-phone')).toBeVisible();
  expect(
    await page
      .locator('.replay-phone')
      .evaluateAll((els) =>
        els.every((el) => el.getBoundingClientRect().bottom <= innerHeight),
      ),
  ).toBe(true);
  await expect(page.getByTestId('resident-phone')).toContainText(
    '반영환 할아버지',
  );
  await expect(page.getByTestId('rescuer-phone')).toContainText('반영환 대원');
  await expect(page.getByTestId('rescuer-phone')).toContainText(
    '박미숙 할머니',
  );
  await expect(page.getByTestId('household-marker')).toHaveCount(48);
  await expect(page.getByTestId('resident-transcript')).toContainText(
    '다리가 아파서',
    { timeout: 8000 },
  );
  await expect(page.getByTestId('trip-vehicle').first()).toBeVisible({
    timeout: 12000,
  });
  await expect(page.getByTestId('fire-layer')).toBeVisible();
  const position = await page
    .getByTestId('trip-vehicle')
    .first()
    .getAttribute('transform');
  await expect
    .poll(async () =>
      page.getByTestId('trip-vehicle').first().getAttribute('transform'),
    )
    .not.toBe(position);
  const at = await page.getByTestId('simulation-time').textContent();
  await expect(page.getByTestId('simulation-time')).not.toHaveText(at!);
  await page.getByRole('button', { name: '전체 가구', exact: true }).click();
  await expect(page.locator('tbody tr')).toHaveCount(48);
  await page
    .getByRole('button', { name: '워크플로 사례', exact: true })
    .click();
  await expect(page.locator('.showcase-case-grid article')).toHaveCount(28);
  await expect(page.getByRole('main')).toContainText('출동 가능 · 차량 없음');
  await expect(page.getByRole('main')).toContainText('대피 거부 · 이장 설득');
  expect(external).toEqual([]);
  expect(errors).toEqual([]);
});
test('visitors can only watch the automatic replay, without pause, speed, repeat or reset controls', async ({
  page,
}) => {
  await page.goto('/?demo=1');
  await enterSimulation(page);
  await expect(page.getByTestId('resident-transcript')).toContainText(
    '다리가 아파서',
    { timeout: 8000 },
  );
  await expect(
    page.getByLabel('시뮬레이션 재생 현황').locator('button, input, select'),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', {
      name: /일시정지|처음 상태로 초기화|초기화하기|▶ 재생/,
    }),
  ).toHaveCount(0);
  await expect(page.getByLabel('재생 속도', { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole('checkbox', { name: '자동 반복', exact: true }),
  ).toHaveCount(0);
  await expect(page.getByTestId('playback-status')).toHaveText(
    '30배속 · 자동 반복 재생',
  );
  const at = await page.getByTestId('simulation-time').textContent();
  await expect(page.getByTestId('simulation-time')).not.toHaveText(at!);
});
test('fire still chars buildings without smoke and a fresh session restores them', async ({
  page,
}) => {
  await page.clock.install({ time: new Date('2026-01-01') });
  await page.goto('/');
  await prepareSimulation(page);
  await page.clock.pauseAt(new Date('2030-01-01'));
  await page
    .getByRole('button', { name: '시뮬레이션 보기 →', exact: true })
    .click();
  const charred = page.locator(
    '[data-testid="house-building"][data-burned="true"]',
  );
  await expect(page.getByTestId('house-building')).toHaveCount(48);
  await expect(charred).toHaveCount(0);
  await page.clock.fastForward(36000);
  const northern = page.locator(
    '[data-testid="house-building"][data-household="H011"]',
  );
  await expect(northern).toHaveAttribute('data-burned', 'true');
  await expect(northern.getByTestId('house-roof')).toHaveAttribute(
    'fill',
    '#030303',
  );
  await expect(
    page.locator('[data-testid="house-building"][data-household="H009"]'),
  ).toHaveAttribute('data-burned', 'false');
  await page.clock.fastForward(40000);
  await expect(northern).toHaveAttribute('data-burned', 'true');
  await expect(page.getByTestId('smoke-layer')).toHaveCount(0);
  await expect(page.getByTestId('smoke-puff')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: '연기 흐름', exact: true }),
  ).toHaveCount(0);
  await expect(page.locator('.legend-smoke')).toHaveCount(0);
  await page.reload();
  await enterSimulation(page);
  await expect(charred).toHaveCount(0);
  await expect(northern.getByTestId('house-roof')).toHaveAttribute(
    'fill',
    '#a59379',
  );
});
test('mobile layout keeps both agent panels usable without horizontal page overflow', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?demo=1');
  await enterSimulation(page);
  await expect(page.getByTestId('resident-phone')).toBeVisible();
  await expect(page.getByTestId('rescuer-phone')).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
