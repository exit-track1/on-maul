import { expect, type Page } from '@playwright/test';

export async function enterSimulation(page: Page) {
  await expect(page.getByTestId('presentation')).toBeVisible();
  for (let i = 0; i < 13; i++)
    await page.getByRole('button', { name: '다음 →', exact: true }).click();
  await page
    .getByRole('button', { name: '시뮬레이션 보기 →', exact: true })
    .click();
  await expect(page.getByTestId('resident-phone')).toBeVisible();
}
