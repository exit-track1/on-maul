import { test, expect } from '@playwright/test';
const demo = '/index.html?demo=1';
test('roster 48 rows, seven filters, drawer history and explicit check', async ({
  page,
}) => {
  await page.goto(demo);
  await page.getByRole('tab', { name: '가구 명단', exact: true }).click();
  await expect(page.getByRole('row')).toHaveCount(49);
  await expect(
    page.getByRole('button', { name: '등급 4 3', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '90일 초과 3', exact: true }).click();
  await expect(page.getByRole('row')).toHaveCount(4);
  await page.locator('tr[data-household="H009"] button').click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(
    page.getByRole('heading', { name: '확인 이력', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: '모의 확인 저장', exact: true })
    .click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: '닫기', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: '90일 초과 2', exact: true }),
  ).toBeVisible();
});
test('offline full flow has no API or external requests and zero calls before confirmation', async ({
  page,
  baseURL,
}) => {
  const unexpected: string[] = [];
  page.on('request', (r) => {
    if (
      r.url().includes('/api/') ||
      new URL(r.url()).origin !== new URL(baseURL!).origin
    )
      unexpected.push(r.url());
  });
  await page.goto(demo);
  await page.getByRole('button', { name: '감시 시작', exact: true }).click();
  await expect(page.locator('.situation')).toContainText('발신 없음');
  await page
    .getByRole('button', { name: '발령 절차 시작', exact: true })
    .click();
  await page
    .getByRole('button', { name: '순서 검토·발령 확정', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toContainText(
    '전화 45 · 방문 3 · 임시 제외 0',
  );
  await expect(page.getByRole('dialog').getByRole('row')).toHaveCount(46);
  await page.getByRole('button', { name: '확정하고 모의 발신 시작' }).click();
  await expect(
    page.locator('.toolbar').filter({ hasText: '공용 채널' }),
  ).toContainText('8/8');
  await page
    .getByRole('button', { name: '모의 1분 진행', exact: true })
    .click();
  await expect(
    page.getByRole('tab', { name: '통화', exact: true }),
  ).toHaveAttribute('aria-selected', 'true');
  expect(unexpected).toEqual([]);
});
test('same counts across all six tabs and 48 keyboard-accessible map markers', async ({
  page,
}) => {
  await page.goto(demo);
  await page.getByLabel('시연 장면', { exact: true }).selectOption('active');
  await expect(page.getByTestId('household-marker')).toHaveCount(48);
  await expect(page.locator('svg [role=button]')).toHaveCount(48);
  for (const label of [
    '지도',
    '통화',
    '자원·5분대기조',
    '가구 명단',
    '데이터 소스',
    '기록',
  ]) {
    await page.getByRole('tab', { name: label, exact: true }).click();
    await expect(page.locator('.situation')).toContainText('조치 필요 11');
    await expect(page.locator('.situation')).toContainText('진행 31');
    await expect(page.locator('.situation')).toContainText('안전 3/45');
  }
});
test('source failure remains 7/8 after collect', async ({ page }) => {
  await page.goto(demo);
  await page.getByRole('button', { name: '감시 시작', exact: true }).click();
  await page.getByRole('tab', { name: '데이터 소스', exact: true }).click();
  await page
    .getByRole('button', { name: '수신 실패 시연', exact: true })
    .first()
    .click();
  await expect(page.locator('.rule-line')).toContainText('7/8');
  await page.getByRole('button', { name: '지금 모의 수집' }).click();
  await expect(page.locator('.rule-line')).toContainText('7/8');
});
test('officer note structure applies a reviewed rule result and retains the previous check date', async ({
  page,
}) => {
  await page.goto(demo);
  await page.getByRole('tab', { name: '가구 명단', exact: true }).click();
  const row = page.locator('tr[data-household="H009"]'),
    original = await row.innerText();
  await row.getByRole('button').click();
  const drawer = page.getByRole('dialog');
  await drawer
    .getByText('비고 규칙 구조화 제안·원문 근거', { exact: true })
    .click();
  await expect(drawer).toContainText('불명 항목을 포함한 보수적 제안');
  await drawer
    .getByRole('button', { name: '원문 규칙 재구조화 적용', exact: true })
    .click();
  await expect(drawer.getByRole('status')).toContainText('규칙 제안 적용됨');
  await page.keyboard.press('Escape');
  await expect(row).toContainText('90일 초과');
  expect(await row.innerText()).toEqual(original);
});
test('stale replay wind remains stale after collection and the map keeps ETA unknown', async ({
  page,
}) => {
  await page.goto(demo);
  await page.getByLabel('시연 장면', { exact: true }).selectOption('late');
  await expect(page.locator('.map-hud')).toContainText('바람 근거 불명/낡음');
  await expect(page.locator('svg')).toContainText('ETA 불명');
  await page.getByRole('tab', { name: '데이터 소스', exact: true }).click();
  const wind = page.getByRole('region', {
    name: 'SRC05 바람 관측',
    exact: true,
  });
  await expect(wind).toContainText('관측 낡음');
  await expect(wind).toContainText('2026-10-09T11:00:00+09:00');
  await page
    .getByRole('button', { name: '지금 모의 수집', exact: true })
    .click();
  await expect(wind).toContainText('관측 낡음');
  await expect(page.locator('.rule-line')).toContainText('실제 모델 호출 0회');
});
test('assistant resource query uses fleet data and an explicit order edit reaches the current plan', async ({
  page,
}) => {
  await page.goto(demo);
  await page.getByRole('button', { name: '감시 시작', exact: true }).click();
  await page
    .getByRole('button', { name: '발령 절차 시작', exact: true })
    .click();
  await page
    .getByRole('button', { name: '상황실 도우미', exact: true })
    .click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: '자원 현황', exact: true })
    .click();
  const answer = page.locator('.assistant-answer');
  await expect(answer).toContainText('수송 자원 9개');
  await expect(answer).toContainText('조원 가능 응답 0/12명');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: '12번 가구 1순위', exact: true })
    .click();
  await expect(answer).toContainText('H012');
  await expect(answer).toContainText('1순위');
  await page.keyboard.press('Escape');
  await expect(page.locator('.log-scroll')).toContainText('담당자 순서 수정');
});
test('handover includes moving and dispatch, freezes snapshot and exports matching IDs', async ({
  page,
}) => {
  await page.goto(demo);
  await page.getByLabel('시연 장면', { exact: true }).selectOption('active');
  await page
    .getByRole('button', { name: '기록으로 종료', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toContainText('미해결 45건');
  await page
    .getByRole('button', { name: '인수인계 확인·종료 스냅샷 저장' })
    .click();
  await expect(
    page.getByRole('heading', { name: '기록·인수인계', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('row')).toHaveCount(46);
  await expect(page.locator('.canvas-scroll')).toContainText('종료 스냅샷');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'JSON 내보내기' }).click();
  expect((await download).suggestedFilename()).toBe('onmaul-mock-report.json');
});
test('keyboard tabs and native modal escape restore access', async ({
  page,
}) => {
  await page.goto(demo);
  await page.getByRole('tab', { name: '지도', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(
    page.getByRole('tab', { name: '통화', exact: true }),
  ).toBeFocused();
  await page
    .getByRole('button', { name: '상황실 도우미', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
test('human reassignment approval shows reserved route and vehicle on the same map', async ({
  page,
}) => {
  await page.goto(demo);
  await page.getByLabel('시연 장면', { exact: true }).selectOption('active');
  await page.getByRole('tab', { name: '자원·5분대기조', exact: true }).click();
  await page
    .getByLabel('남구역 대기조 재배정 대상', { exact: true })
    .selectOption('H041');
  await page
    .getByRole('button', { name: '재배정 후보 검토', exact: true })
    .nth(3)
    .click();
  await expect(
    page.getByRole('region', { name: '재배정 승인 대기' }),
  ).toContainText('H041 재배정 승인 대기');
  await expect(page.locator('.resource-summary')).toContainText(
    '현재 임무 0건',
  );
  await page
    .getByRole('button', { name: 'V06 재배정 승인', exact: true })
    .click();
  await expect(page.locator('.resource-summary')).toContainText(
    '현재 임무 1건',
  );
  await expect(
    page.getByRole('region', { name: '재배정 승인 대기' }),
  ).not.toContainText('H041 재배정 승인 대기');
  await page.getByRole('tab', { name: '지도', exact: true }).click();
  await expect(page.getByTestId('trip-vehicle')).toHaveCount(1);
  await expect(page.getByTestId('trip-route')).toHaveCount(3);
  await expect(page.getByTestId('trip-vehicle')).toHaveAttribute(
    'aria-label',
    /V06 H041 depart/,
  );
  await page.screenshot({
    path: 'test-results/validated-trip.png',
    fullPage: true,
  });
});
test('drawer stores synthetic companion count before a transport reservation', async ({
  page,
}) => {
  await page.goto(demo);
  await page.getByRole('tab', { name: '가구 명단', exact: true }).click();
  await page.locator('tr[data-household="H041"] button').click();
  const drawer = page.getByRole('dialog');
  await drawer
    .getByLabel('동반자 가상 표시', { exact: true })
    .fill('모의 보호자');
  await drawer
    .getByRole('button', { name: '가상 동반자 추가', exact: true })
    .click();
  await expect(drawer).toContainText('본인 포함 2명');
  await expect(drawer).toContainText('모의 보호자 · 자력');
});
test('moving callback is visible and explicit arrival removes its reservation', async ({
  page,
}) => {
  await page.goto(demo);
  await page.getByLabel('시연 장면', { exact: true }).selectOption('active');
  await page.getByRole('tab', { name: '통화', exact: true }).click();
  await page.getByText('모의 전사·분류 시연', { exact: true }).click();
  await page
    .getByRole('combobox', { name: '가구', exact: true })
    .selectOption('H041');
  await page
    .getByLabel('허구 발화', { exact: true })
    .fill('지금 이동 중이에요');
  await page
    .getByRole('button', { name: '모의 전사 적용', exact: true })
    .click();
  await page.getByText('후속 확인 예약·시도 이력', { exact: true }).click();
  const reservations = page.getByRole('region', { name: '후속 확인 예약' });
  await expect(reservations).toContainText(
    'H041 · 이동 후 도착 재확인 · T+23분',
  );
  await page.getByLabel('허구 발화', { exact: true }).fill('학교에 도착했어요');
  await page
    .getByRole('button', { name: '모의 전사 적용', exact: true })
    .click();
  await expect(reservations).not.toContainText('H041');
  await expect(page.locator('tr[data-household="H041"]')).toContainText(
    '대피 완료',
  );
});
test('member no-answer simulation exposes recall count and reaches unavailable after two recalls', async ({
  page,
}) => {
  await page.goto(demo);
  await page.getByRole('button', { name: '감시 시작', exact: true }).click();
  await page
    .getByRole('button', { name: '발령 절차 시작', exact: true })
    .click();
  await page
    .getByRole('button', { name: '순서 검토·발령 확정', exact: true })
    .click();
  await page
    .getByRole('button', { name: '확정하고 모의 발신 시작', exact: true })
    .click();
  await page.getByRole('tab', { name: '자원·5분대기조', exact: true }).click();
  const member = page.locator('li[data-member="M01"]');
  await page
    .getByRole('button', { name: 'M01 모의 무응답', exact: true })
    .click();
  await expect(member).toContainText('재호출 1/2 대기');
  for (let i = 0; i < 12; i++) {
    await page.getByRole('tab', { name: '통화', exact: true }).click();
    await page
      .getByRole('button', { name: '모의 1분 진행', exact: true })
      .click();
    await page
      .getByRole('tab', { name: '자원·5분대기조', exact: true })
      .click();
    if ((await member.innerText()).includes('모의 불가 응답')) break;
  }
  await expect(member).toContainText('모의 불가 응답');
  await expect(
    page.getByRole('button', { name: 'M01 모의 무응답', exact: true }),
  ).toHaveCount(0);
});
for (const [width, height] of [
  [1920, 1080],
  [1366, 768],
  [1280, 800],
  [390, 844],
])
  test(`layout and screenshot ${width}x${height}`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setViewportSize({ width, height });
    await page.goto(demo);
    await page.getByLabel('시연 장면', { exact: true }).selectOption('active');
    await expect(page.getByTestId('household-marker')).toHaveCount(48);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/map-${width}x${height}.png`,
      fullPage: true,
    });
    await page.getByRole('tab', { name: '통화', exact: true }).click();
    await expect(page.getByTestId('counters')).toContainText('3/45');
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    if (width === 1366) {
      const row = await page.getByRole('row').nth(5).boundingBox();
      expect(row!.y + row!.height).toBeLessThanOrEqual(height);
    }
    await page.screenshot({
      path: `test-results/calls-${width}x${height}.png`,
      fullPage: true,
    });
    expect(errors).toEqual([]);
  });
