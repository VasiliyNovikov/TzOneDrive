import { test, expect } from '@playwright/test';

async function openCollection(page) {
  await page.goto('./');
  await expect(page.getByRole('button', { name: 'Explore collections' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-focus-id="folder-coastal-quiet"]')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-focus-id="photo-coast"]')).toBeFocused();
}

test('static preview loads scripts, styles, photos and matching metadata beneath its base URL', async ({ page, baseURL }) => {
  const requests = [];
  const failures = [];
  page.on('request', request => requests.push(request.url()));
  page.on('requestfailed', request => failures.push(request.url()));
  page.on('response', response => {
    if (response.status() >= 400) failures.push(response.url());
  });
  await openCollection(page);
  await page.keyboard.press('Enter');
  await expect(page.locator('.full-photo')).toHaveClass(/loaded/);
  await expect(page.locator('#build-mark')).toBeInViewport();
  for (const asset of ['main.js', 'styles.css', 'assets/photos/coast.svg']) {
    expect(requests).toContain(new URL(asset, baseURL).href);
  }
  expect(requests.every(url => url.startsWith(baseURL))).toBe(true);
  expect(failures).toEqual([]);
  const response = await page.request.get(new URL('build.json', baseURL).href);
  expect(response.ok()).toBe(true);
  const identity = await response.json();
  expect(identity.commit).toMatch(/^[a-f0-9]{40}$/);
  await expect(page.locator('#build-mark')).toHaveAttribute('data-build-commit', identity.commit);
});

test('startup shows complete build/device identity and records keyboard and Tizen Back input', async ({ page, baseURL }) => {
  const errors = [];
  const remoteRequests = [];
  const appOrigin = new URL(baseURL).origin;
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (new URL(request.url()).origin !== appOrigin) remoteRequests.push(request.url());
  });
  await page.goto('./');
  await expect(page.getByRole('heading', { name: 'Device diagnostics' })).toBeVisible();
  await expect(page.locator('#diagnostic-commit')).toHaveText(/^[a-f0-9]{40}$/);
  await expect(page.locator('#diagnostic-viewport')).toContainText(String(page.viewportSize().width));
  await expect(page.locator('.runtime-row')).toContainText('Chrome/');
  const commit = await page.locator('#diagnostic-commit').innerText();
  await expect(page.locator('#build-mark')).toHaveAttribute('data-build-commit', commit);
  await expect(page.locator('#build-mark')).toContainText(commit);
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#diagnostic-key')).toContainText('ArrowRight');
  await expect(page.getByRole('button', { name: 'About sign-in' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'A place for your own memories.' })).toBeVisible();
  await expect(page.getByText('Microsoft sign-in is not available in this preview.')).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 10009, key: 'Unidentified' })));
  await expect(page.getByRole('heading', { name: 'Good places. Great moments.' })).toBeVisible();
  await page.keyboard.press('i');
  await expect(page.locator('#diagnostic-key')).toContainText('i');
  expect(errors).toEqual([]);
  expect(remoteRequests).toEqual([]);
});

test('fresh camera challenges stay visible without moving focus or restarting the slideshow', async ({ page }) => {
  await page.clock.install();
  await page.goto('./');
  const commit = await page.locator('#diagnostic-commit').innerText();
  await page.keyboard.type('000123');
  await expect(page.locator('#camera-challenge')).toHaveText('000123');
  await expect(page.getByRole('button', { name: 'Explore collections' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-focus-id="folder-coastal-quiet"]')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-focus-id="photo-coast"]')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-focus-id="photo-stage"]')).toBeFocused();
  await page.keyboard.press('Enter');
  await page.clock.fastForward(3000);
  await page.evaluate(() => {
    for (const digit of '987654') {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Unidentified', keyCode: 48 + Number(digit) }));
    }
  });
  await expect(page.locator('#camera-challenge')).toHaveText('987654');
  await expect(page.locator('#build-mark')).toContainText(commit);
  await expect(page.locator('#build-mark')).toBeInViewport();
  await expect(page.locator('[data-focus-id="photo-stage"]')).toBeFocused();
  await page.clock.fastForward(2100);
  await expect(page.getByRole('heading', { name: 'A softer horizon' })).toBeVisible();
  await expect(page.locator('#slideshow-status')).toHaveText('Slideshow playing');
  await expect(page.locator('#camera-challenge')).toHaveText('987654');
});

test('arrows, Enter and Back navigate grids with exact folder and photo focus restoration', async ({ page }) => {
  await page.goto('./');
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('[data-focus-id="folder-alpine-light"]')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Alpine light' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-focus-id="folder-alpine-light"]')).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-focus-id="photo-coast"]')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('[data-focus-id="photo-tide"]')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('[data-focus-id="photo-lighthouse"]')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'The way home' })).toBeVisible();
  await expect(page.locator('[data-focus-id="photo-stage"]')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('heading', { name: 'One more minute' })).toBeVisible();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('heading', { name: 'The way home' })).toBeVisible();
  await page.keyboard.press('Backspace');
  await expect(page.locator('[data-focus-id="photo-lighthouse"]')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-focus-id="folder-coastal-quiet"]')).toBeFocused();
});

test('slideshow advances once per interval, pauses on Back, and stops when diagnostics opens', async ({ page }) => {
  await page.clock.install();
  await openCollection(page);
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-focus-id="photo-stage"]')).toBeFocused();
  await expect(page.locator('.full-photo')).toHaveClass(/loaded/);
  await page.keyboard.press('Enter');
  await expect(page.locator('#slideshow-status')).toHaveText('Slideshow playing');
  await page.clock.fastForward(5100);
  await expect(page.getByRole('heading', { name: 'A softer horizon' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#slideshow-status')).toHaveText('Slideshow paused');
  await page.clock.fastForward(11000);
  await expect(page.getByRole('heading', { name: 'A softer horizon' })).toBeVisible();
  await page.keyboard.press('Enter');
  await page.keyboard.press('i');
  await expect(page.getByRole('heading', { name: 'Device diagnostics' })).toBeVisible();
  await page.clock.fastForward(11000);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: 'A softer horizon' })).toBeVisible();
  await expect(page.locator('#slideshow-status')).toHaveText('Slideshow paused');
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-focus-id="photo-coast"]')).toBeFocused();
});

test('failed local images show a bounded fallback and retain keyboard navigation', async ({ page }) => {
  await page.route('**/assets/photos/coast.svg', (route) => route.abort());
  await openCollection(page);
  await expect(page.locator('[data-focus-id="photo-coast"] .image-fallback')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.locator('.full-photo .image-fallback')).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('heading', { name: 'A softer horizon' })).toBeVisible();
  await expect(page.locator('.full-photo')).toHaveClass(/loaded/);
});
