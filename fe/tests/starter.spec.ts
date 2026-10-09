import { expect, test } from '@playwright/test';

test('the starter opens an empty workspace without business-data requests', async ({
  page,
}) => {
  const runtimeErrors: string[] = [];
  const requests: string[] = [];
  page.on('pageerror', (error) => runtimeErrors.push(error.message));
  page.on('request', (request) => {
    if (['fetch', 'xhr'].includes(request.resourceType()))
      requests.push(request.url());
  });
  await page.route('https://cdn.jsdelivr.net/**', (route) => route.abort());
  await page.route('https://fonts.googleapis.com/**', (route) => route.abort());
  await page.goto('/');
  await expect(page).toHaveTitle('React 디자인 스타터');
  await expect(
    page.getByRole('complementary', { name: '사이드바' }),
  ).toContainText('메뉴 영역');
  await expect(page.getByRole('region', { name: '작업 영역' })).toContainText(
    '아직 콘텐츠가 없습니다',
  );
  await expect(page.getByRole('region', { name: '캔버스' })).toContainText(
    '아직 선택한 항목이 없습니다',
  );
  await expect(page.locator('table, canvas')).toHaveCount(0);
  expect(runtimeErrors).toEqual([]);
  expect(requests).toEqual([]);
});
