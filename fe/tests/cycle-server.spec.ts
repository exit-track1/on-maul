import { test, expect } from '@playwright/test';
import type { View } from '../../shared/src/runtime.ts';

for (const story of ['grandfather', 'squad'])
  test(`disabled telephone engine blocks the ${story} main cycle without mock fallback`, async ({
    page,
    request,
    baseURL,
  }) => {
    const external: string[] = [];
    page.on('request', (r) => {
      if (new URL(r.url()).origin !== new URL(baseURL!).origin)
        external.push(new URL(r.url()).origin);
    });
    const state = async (): Promise<View> => {
      const response = await request.get('/api/state');
      expect(response.ok()).toBe(true);
      return response.json();
    };
    await page.goto('/');
    await expect(page.getByText('서버 연결', { exact: true })).toBeVisible();
    await page.getByLabel('메인 시연', { exact: true }).selectOption(story);
    await expect(page.getByLabel('전화 모드', { exact: true })).toHaveCount(0);
    await expect(page.getByTestId('cycle-start')).toBeDisabled();
    await expect(
      page.getByText('전화 연결 준비 필요 · 시연 시작 불가', {
        exact: true,
      }),
    ).toBeVisible();
    const before = await state();
    await page.waitForTimeout(750);
    const after = await state();
    expect(after.demonstration).toBeNull();
    expect(after.calls).toEqual([]);
    expect(after.simMinutes).toBe(before.simMinutes);
    expect(after.sourceState.actualModelCalls).toBe(0);
    await page.getByRole('tab', { name: '통화 내역', exact: true }).click();
    const history = page.getByTestId('call-history');
    await expect(
      history.getByRole('button', { name: '박미숙 할머니', exact: false }),
    ).toHaveCount(0);
    await expect(
      history.getByRole('button', {
        name: story === 'grandfather' ? '반영환 할아버지' : '반영환 대원',
        exact: false,
      }),
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(history).toContainText('실제 통화 내역이 없습니다');
    await expect(page.getByTestId('demo-resident-marker')).toBeVisible();
    expect(external).toEqual([]);
  });
