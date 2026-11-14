import { expect, test } from '@playwright/test';

test('version.json is served and matches the footer', async ({ page, request }) => {
  const res = await request.get('/version.json');
  expect(res.ok()).toBe(true);
  const v = await res.json();
  expect(Object.keys(v).sort()).toEqual(['buildTime', 'commit', 'version']);
  expect(v.commit).toMatch(/^[0-9a-f]{40}$/);
  expect(new Date(v.buildTime).toString()).not.toBe('Invalid Date');

  await page.goto('/');
  await expect(page.getByTestId('app-version')).toHaveText(`Version ${v.version} (${v.commit.slice(0, 7)})`);
});
