import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const demo = '/index.html?demo=1';

async function chooseScene(page: Page, id: string) {
  const tools = page.locator('details.static-scene-tools');
  if ((await tools.getAttribute('open')) === null)
    await tools.getByText('정적 장면 점검', { exact: true }).click();
  await page.getByLabel('시연 장면', { exact: true }).selectOption(id);
}

test('terrain, moving residents and vehicles are local and preview does not alter operational counts', async ({
  page,
  baseURL,
}) => {
  const external: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).origin !== new URL(baseURL!).origin)
      external.push(request.url());
  });
  await page.goto(demo);
  await chooseScene(page, 'active');
  await expect(page.locator('.map-movement-summary')).toContainText('10가구');
  await expect(page.getByTestId('moving-vehicle')).toHaveCount(2);
  await expect(page.getByTestId('movement-route')).toHaveCount(12);
  await expect(page.getByTestId('fire-layer')).toBeVisible();
  await expect(page.getByTestId('fire-forecast')).toBeVisible();
  await expect(page.getByTestId('smoke-layer')).toBeVisible();
  const before = await page.getByTestId('fire-perimeter').getAttribute('d');
  const counts = await page.locator('.situation').innerText();
  const vehicle = await page
    .getByTestId('moving-vehicle')
    .first()
    .getAttribute('transform');
  await page.getByLabel('미리보기 시간', { exact: true }).fill('7');
  await expect(page.getByTestId('preview-time')).toHaveText('+7.0분');
  expect(await page.getByTestId('fire-perimeter').getAttribute('d')).not.toBe(
    before,
  );
  expect(
    await page.getByTestId('moving-vehicle').first().getAttribute('transform'),
  ).not.toBe(vehicle);
  await expect(page.locator('.situation')).toHaveText(counts, {
    useInnerText: true,
  });
  await expect(page.locator('.map-hud')).toContainText('기준 T+8분');
  await page
    .getByRole('button', { name: '미리보기 초기화', exact: true })
    .click();
  await expect(page.getByTestId('fire-perimeter')).toHaveAttribute(
    'd',
    before!,
  );
  const loaded = await page.locator('.map image').evaluate(async (image) => {
    const probe = new Image();
    probe.src = image.getAttribute('href')!;
    await probe.decode();
    return { width: probe.naturalWidth, height: probe.naturalHeight };
  });
  expect(loaded).toEqual({ width: 2400, height: 1520 });
  expect(external).toEqual([]);
});

test('playback, layer switches, zoom and keyboard house selection remain independent', async ({
  page,
}) => {
  await page.goto(demo);
  await chooseScene(page, 'active');
  await page
    .getByRole('button', { name: '이동·확산 미리보기 재생', exact: true })
    .click();
  await expect(page.getByTestId('preview-time')).not.toHaveText('+0.0분');
  await page
    .getByRole('button', { name: '이동·확산 미리보기 일시정지', exact: true })
    .click();
  await expect(page.locator('.terrain-map')).toHaveClass(/is-paused/);
  const paused = await page.getByTestId('fire-perimeter').getAttribute('d');
  await page.getByRole('button', { name: '주민 이동', exact: true }).click();
  await expect(page.getByTestId('moving-person')).toHaveCount(0);
  await expect(page.getByTestId('moving-vehicle')).toHaveCount(2);
  await page.getByRole('button', { name: '차량 이동', exact: true }).click();
  await expect(page.getByTestId('moving-vehicle')).toHaveCount(0);
  await page.getByRole('button', { name: '산불 확산', exact: true }).click();
  await expect(page.getByTestId('fire-layer')).toHaveCount(0);
  await expect(page.getByTestId('smoke-layer')).toBeVisible();
  await page.getByRole('button', { name: '연기 흐름', exact: true }).click();
  await expect(page.getByTestId('smoke-layer')).toHaveCount(0);
  await expect(page.getByTestId('fire-forecast')).toBeVisible();
  await page.getByRole('button', { name: '연기 흐름', exact: true }).click();
  await expect(page.getByTestId('smoke-layer')).toBeVisible();
  await expect(page.getByTestId('fire-forecast')).toBeVisible();
  await page.getByRole('button', { name: '10분 후', exact: true }).click();
  await expect(page.getByTestId('fire-forecast')).toHaveCount(0);
  await page.getByRole('button', { name: '산불 확산', exact: true }).click();
  await expect(page.getByTestId('fire-perimeter')).toHaveAttribute(
    'd',
    paused!,
  );
  await page.getByRole('button', { name: '지도 확대', exact: true }).click();
  await expect(page.locator('svg.map')).not.toHaveAttribute(
    'viewBox',
    '0 0 1200 760',
  );
  await page
    .getByRole('button', { name: '지도 시점 초기화', exact: true })
    .click();
  await expect(page.locator('svg.map')).toHaveAttribute(
    'viewBox',
    '0 0 1200 760',
  );
  const marker = page.locator('svg.map [role="button"]').first();
  await marker.focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('button', { name: '가구 상세 열기', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: '가구 상세 열기', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toContainText('H001');
});

test('stale wind hides fire prediction and frozen records disable playback', async ({
  page,
}) => {
  await page.goto(demo);
  await chooseScene(page, 'late');
  await expect(page.locator('.map-hud')).toContainText('바람 근거 불명/낡음');
  await expect(page.getByTestId('fire-layer')).toHaveCount(0);
  await expect(page.getByTestId('fire-forecast')).toHaveCount(0);
  await expect(page.locator('svg.map')).toContainText('ETA 불명');
  await expect(page.getByTestId('smoke-layer')).toHaveCount(0);
  await chooseScene(page, 'active');
  await page
    .getByRole('button', { name: '기록으로 종료', exact: true })
    .click();
  await page
    .getByRole('button', {
      name: '인수인계 확인·종료 스냅샷 저장',
      exact: true,
    })
    .click();
  await page.getByRole('tab', { name: '지도', exact: true }).click();
  await expect(
    page.getByRole('button', { name: '이동·확산 미리보기 재생', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByLabel('미리보기 시간', { exact: true }),
  ).toBeDisabled();
  await expect(page.locator('.map-hud')).toContainText('종료 시점 기록');
});
