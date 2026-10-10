import { expect, test } from '@playwright/test';

test('entry shows PDF pages 1–15 except 11 in order, and only then reveals the simulation', async ({
  page,
  baseURL,
}) => {
  const requests: string[] = [];
  const errors: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/?demo=1');
  await expect(page.getByTestId('presentation')).toBeVisible();
  await expect(page.getByTestId('resident-phone')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: '← 이전', exact: true }),
  ).toBeDisabled();
  const pages = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 13, 14, 15];
  for (const [index, originalPage] of pages.entries()) {
    const image = page.getByTestId('presentation-slide');
    await expect(image).toHaveAttribute('data-pdf-page', String(originalPage));
    await expect(page.getByTestId('presentation-progress')).toHaveText(
      `${index + 1} / 14`,
    );
    const next = page.getByRole('button', {
      name: index === 13 ? '시뮬레이션 보기 →' : '다음 →',
      exact: true,
    });
    await expect(next).toBeEnabled();
    expect(
      await image.evaluate((element: HTMLImageElement) => element.naturalWidth),
    ).toBe(2400);
    await expect(page.getByTestId('resident-phone')).toHaveCount(0);
    await next.click();
  }
  await expect(page.getByTestId('presentation')).toHaveCount(0);
  await expect(page.getByTestId('resident-phone')).toBeVisible();
  await expect(page.getByTestId('rescuer-phone')).toBeVisible();
  await expect(
    page.getByLabel('시뮬레이션 재생 현황').locator('button, input, select'),
  ).toHaveCount(0);
  expect(
    requests.some((url) => /page-(11|16|17)\.|\.pdf(?:\?|$)/.test(url)),
  ).toBe(false);
  expect(
    requests.some((url) => new URL(url).pathname.startsWith('/api/')),
  ).toBe(false);
  expect(
    requests.every((url) => new URL(url).origin === new URL(baseURL!).origin),
  ).toBe(true);
  expect(errors).toEqual([]);
  await page.reload();
  await expect(page.getByTestId('presentation-slide')).toHaveAttribute(
    'data-pdf-page',
    '1',
  );
});

test('previous and arrow keys navigate slides, and mobile keeps the slide and navigation inside the viewport', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?demo=1');
  const next = page.getByRole('button', { name: '다음 →', exact: true });
  await expect(next).toBeEnabled();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('presentation-slide')).toHaveAttribute(
    'data-pdf-page',
    '2',
  );
  await expect(next).toBeEnabled();
  await page.getByRole('button', { name: '← 이전', exact: true }).click();
  await expect(page.getByTestId('presentation-slide')).toHaveAttribute(
    'data-pdf-page',
    '1',
  );
  await expect(next).toBeEnabled();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('presentation-slide')).toHaveAttribute(
    'data-pdf-page',
    '2',
  );
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByTestId('presentation-slide')).toHaveAttribute(
    'data-pdf-page',
    '1',
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(
    await page
      .locator('.presentation-footer')
      .evaluate(
        (element) => element.getBoundingClientRect().bottom <= innerHeight,
      ),
  ).toBe(true);
  expect(
    await page.getByTestId('presentation-slide').evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return (
        bounds.width > 0 &&
        bounds.left >= 0 &&
        bounds.right <= innerWidth &&
        bounds.top >= 0 &&
        bounds.bottom <= innerHeight
      );
    }),
  ).toBe(true);
});
