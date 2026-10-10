import { expect, test } from '@playwright/test';

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
  await page.getByRole('button', { name: 'Ⅱ 일시정지', exact: true }).click();
  const at = await page.getByTestId('simulation-time').textContent();
  await page.waitForTimeout(450);
  await expect(page.getByTestId('simulation-time')).toHaveText(at!);
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
test('reset waits at the first frame with no old call history and can restart', async ({
  page,
}) => {
  await page.goto('/?demo=1');
  await expect(page.getByTestId('resident-transcript')).toContainText(
    '다리가 아파서',
    { timeout: 8000 },
  );
  await page
    .getByRole('button', { name: '처음 상태로 초기화', exact: true })
    .click();
  await page.getByRole('button', { name: '초기화하기', exact: true }).click();
  await expect(page.getByTestId('simulation-time')).toHaveText('T+0.0분');
  await expect(page.getByTestId('case-coverage')).toHaveText('0/28');
  await expect(page.locator('.replay-turn')).toHaveCount(0);
  await page.getByRole('button', { name: '▶ 재생', exact: true }).click();
  await expect(page.getByTestId('resident-phone')).toContainText(
    '반영환 할아버지',
  );
  await expect(page.getByTestId('rescuer-phone')).toContainText('반영환 대원');
});
test('mobile layout keeps both agent panels usable without horizontal page overflow', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?demo=1');
  await expect(page.getByTestId('resident-phone')).toBeVisible();
  await expect(page.getByTestId('rescuer-phone')).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
