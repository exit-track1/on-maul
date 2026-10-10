import { expect, test } from '@playwright/test';

test('deployed-style dashboard uses only its own state endpoints with no token or phone API', async ({
  page,
  baseURL,
}) => {
  const requests: string[] = [],
    errors: string[] = [];
  page.on('request', (req) => requests.push(req.url()));
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(
    page.getByText('시뮬레이션 서버 연결', { exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId('resident-phone')).toContainText(
    '반영환 할아버지',
  );
  await expect(page.getByTestId('rescuer-phone')).toContainText(
    '박미숙 할머니',
  );
  await page.getByRole('button', { name: 'Ⅱ 일시정지', exact: true }).click();
  await page
    .getByRole('button', { name: '처음 상태로 초기화', exact: true })
    .click();
  await page.getByRole('button', { name: '초기화하기', exact: true }).click();
  await expect(page.getByTestId('simulation-time')).toHaveText('T+0.0분');
  await page.getByRole('button', { name: '▶ 재생', exact: true }).click();
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
});
