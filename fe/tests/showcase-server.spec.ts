import { expect, test } from '@playwright/test';
import { enterSimulation } from './helpers/presentation';

test('deployed-style dashboard uses only its own state endpoints with no token or phone API', async ({
  page,
  baseURL,
}) => {
  const requests: string[] = [],
    errors: string[] = [];
  page.on('request', (req) => requests.push(req.url()));
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await enterSimulation(page);
  await expect(
    page.getByText('시뮬레이션 서버 연결', { exact: true }),
  ).toBeVisible();
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
  expect(requests.some((url) => new URL(url).pathname === '/api/command')).toBe(
    false,
  );
});
