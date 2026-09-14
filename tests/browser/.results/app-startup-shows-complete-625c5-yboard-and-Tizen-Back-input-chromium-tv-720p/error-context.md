# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: app.spec.mjs >> startup shows complete build/device identity and records keyboard and Tizen Back input
- Location: tests/browser/app.spec.mjs:12:1

# Error details

```
Error: expect(received).toEqual(expected) // deep equality

- Expected  - 1
+ Received  + 3

- Array []
+ Array [
+   "http://127.0.0.1:4173/",
+ ]
```

# Page snapshot

```yaml
- generic [ref=e1]:
  - generic [ref=e2]:
    - banner [ref=e3]:
      - generic [ref=e4]: OneDrive / Photos
      - navigation "Main navigation" [ref=e6]:
        - button "Collections" [ref=e7] [cursor=pointer]
        - button "Diagnostics" [ref=e8] [cursor=pointer]
        - button "Connect account" [ref=e9] [cursor=pointer]
    - main [ref=e11]:
      - generic [ref=e12]:
        - paragraph [ref=e13]: LOCAL PREVIEW · READY TO EXPLORE
        - heading "Your memories. A bigger canvas." [level=1] [ref=e15]: Your memories.A bigger canvas.
        - paragraph [ref=e16]: A quieter way to enjoy your photos.Made for the sofa. Ready for your remote.
        - generic [ref=e17]:
          - button "Explore collections" [ref=e18] [cursor=pointer]: Explore collections ↗
          - button "About sign-in" [active] [ref=e19] [cursor=pointer]
        - generic [ref=e20]:
          - generic [aria-hidden] [ref=e21]: ✧
          - paragraph [ref=e22]:
            - strong [ref=e23]: A private, offline preview
            - text: All scenes are bundled synthetic illustrations.No account, personal photos, or network requests.
      - region [ref=e24]:
        - generic [ref=e25]:
          - heading "Device diagnostics" [level=2] [ref=e26]
          - generic [ref=e27]: LIVE
        - paragraph [ref=e28]: Build identity and remote input, visible before you begin.
        - generic [ref=e29]:
          - generic [ref=e30]:
            - term [ref=e31]: Application
            - definition [ref=e32]: v1.0.0 / development
          - generic [ref=e33]:
            - term [ref=e34]: Full commit ID
            - definition [ref=e35]: 43c7dcdbf09f31916a6dbf1220a8149e15bd6749
          - generic [ref=e36]:
            - term [ref=e37]: Build ID
            - definition [ref=e38]: 43c7dcdbf09f31916a6dbf1220a8149e15bd6749
          - generic [ref=e39]:
            - term [ref=e40]: Platform
            - definition [ref=e41]: Browser / keyboard
          - generic [ref=e42]:
            - term [ref=e43]: Viewport
            - definition [ref=e44]: 1280 × 720 · 1× DPR
          - generic [ref=e45]:
            - term [ref=e46]: Last key
            - definition [ref=e47]: i · 73
          - generic [ref=e48]:
            - term [ref=e49]: Image pipeline
            - definition [ref=e50]: 0/3 active · 0 queued · 3/16 cached
          - generic [ref=e51]:
            - term [ref=e52]: Runtime user agent
            - definition [ref=e53]: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/153.0.8010.12 Safari/537.36
        - paragraph [ref=e54]: "Provisional target: Chromium 94+. Device compatibility requires a real-TV check."
    - contentinfo [ref=e55]:
      - generic [ref=e56]:
        - generic [ref=e57]: ↑↓←→
        - text: Navigate
      - generic [ref=e58]:
        - generic [ref=e59]: OK
        - text: Select
      - generic [ref=e60]:
        - generic [ref=e61]: ↩
        - text: Back
      - generic [ref=e62]:
        - generic [ref=e63]: i
        - text: Diagnostics
  - complementary "Visible build identity":
    - generic:
      - text: BUILD
      - strong: v1.0.0 · 43c7dcdbf09f
```

# Test source

```ts
  1   | import { test, expect } from '@playwright/test';
  2   | 
  3   | async function openCollection(page) {
  4   |   await page.goto('/');
  5   |   await expect(page.getByRole('button', { name: 'Explore collections' })).toBeFocused();
  6   |   await page.keyboard.press('Enter');
  7   |   await expect(page.locator('[data-focus-id="folder-coastal-quiet"]')).toBeFocused();
  8   |   await page.keyboard.press('Enter');
  9   |   await expect(page.locator('[data-focus-id="photo-coast"]')).toBeFocused();
  10  | }
  11  | 
  12  | test('startup shows complete build/device identity and records keyboard and Tizen Back input', async ({ page }) => {
  13  |   const errors = [];
  14  |   const remoteRequests = [];
  15  |   page.on('pageerror', (error) => errors.push(error.message));
  16  |   page.on('request', (request) => {
  17  |     if (new URL(request.url()).origin !== new URL(page.url()).origin) remoteRequests.push(request.url());
  18  |   });
  19  |   await page.goto('/');
  20  |   await expect(page.getByRole('heading', { name: 'Device diagnostics' })).toBeVisible();
  21  |   await expect(page.locator('#diagnostic-commit')).toHaveText(/^[a-f0-9]{40}$/);
  22  |   await expect(page.locator('#diagnostic-viewport')).toContainText(String(page.viewportSize().width));
  23  |   await expect(page.locator('.runtime-row')).toContainText('Chrome/');
  24  |   const commit = await page.locator('#diagnostic-commit').innerText();
  25  |   await expect(page.locator('#build-mark')).toHaveAttribute('data-build-commit', commit);
  26  |   await expect(page.locator('#build-mark')).toContainText(commit.slice(0, 12));
  27  |   await page.keyboard.press('ArrowRight');
  28  |   await expect(page.locator('#diagnostic-key')).toContainText('ArrowRight');
  29  |   await expect(page.getByRole('button', { name: 'About sign-in' })).toBeFocused();
  30  |   await page.keyboard.press('Enter');
  31  |   await expect(page.getByRole('heading', { name: 'A place for your own memories.' })).toBeVisible();
  32  |   await expect(page.getByText('Microsoft sign-in is not available in this preview.')).toBeVisible();
  33  |   await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 10009, key: 'Unidentified' })));
  34  |   await expect(page.getByRole('heading', { name: 'Good places. Great moments.' })).toBeVisible();
  35  |   await page.keyboard.press('i');
  36  |   await expect(page.locator('#diagnostic-key')).toContainText('i');
  37  |   expect(errors).toEqual([]);
> 38  |   expect(remoteRequests).toEqual([]);
      |                          ^ Error: expect(received).toEqual(expected) // deep equality
  39  | });
  40  | 
  41  | test('arrows, Enter and Back navigate grids with exact folder and photo focus restoration', async ({ page }) => {
  42  |   await page.goto('/');
  43  |   await page.keyboard.press('Enter');
  44  |   await page.keyboard.press('ArrowRight');
  45  |   await expect(page.locator('[data-focus-id="folder-alpine-light"]')).toBeFocused();
  46  |   await page.keyboard.press('Enter');
  47  |   await expect(page.getByRole('heading', { name: 'Alpine light' })).toBeVisible();
  48  |   await page.keyboard.press('Escape');
  49  |   await expect(page.locator('[data-focus-id="folder-alpine-light"]')).toBeFocused();
  50  |   await page.keyboard.press('ArrowLeft');
  51  |   await page.keyboard.press('Enter');
  52  |   await expect(page.locator('[data-focus-id="photo-coast"]')).toBeFocused();
  53  |   await page.keyboard.press('ArrowDown');
  54  |   await expect(page.locator('[data-focus-id="photo-tide"]')).toBeFocused();
  55  |   await page.keyboard.press('ArrowRight');
  56  |   await expect(page.locator('[data-focus-id="photo-lighthouse"]')).toBeFocused();
  57  |   await page.keyboard.press('Enter');
  58  |   await expect(page.getByRole('heading', { name: 'The way home' })).toBeVisible();
  59  |   await expect(page.locator('[data-focus-id="photo-stage"]')).toBeFocused();
  60  |   await page.keyboard.press('ArrowRight');
  61  |   await expect(page.getByRole('heading', { name: 'One more minute' })).toBeVisible();
  62  |   await page.keyboard.press('ArrowLeft');
  63  |   await expect(page.getByRole('heading', { name: 'The way home' })).toBeVisible();
  64  |   await page.keyboard.press('Backspace');
  65  |   await expect(page.locator('[data-focus-id="photo-lighthouse"]')).toBeFocused();
  66  |   await page.keyboard.press('Escape');
  67  |   await expect(page.locator('[data-focus-id="folder-coastal-quiet"]')).toBeFocused();
  68  | });
  69  | 
  70  | test('slideshow advances once per interval, pauses on Back, and stops when diagnostics opens', async ({ page }) => {
  71  |   await page.clock.install();
  72  |   await openCollection(page);
  73  |   await page.keyboard.press('Enter');
  74  |   await expect(page.locator('[data-focus-id="photo-stage"]')).toBeFocused();
  75  |   await expect(page.locator('.full-photo')).toHaveClass(/loaded/);
  76  |   await page.keyboard.press('Enter');
  77  |   await expect(page.locator('#slideshow-status')).toHaveText('Slideshow playing');
  78  |   await page.clock.fastForward(5100);
  79  |   await expect(page.getByRole('heading', { name: 'A softer horizon' })).toBeVisible();
  80  |   await page.keyboard.press('Escape');
  81  |   await expect(page.locator('#slideshow-status')).toHaveText('Slideshow paused');
  82  |   await page.clock.fastForward(11000);
  83  |   await expect(page.getByRole('heading', { name: 'A softer horizon' })).toBeVisible();
  84  |   await page.keyboard.press('Enter');
  85  |   await page.keyboard.press('i');
  86  |   await expect(page.getByRole('heading', { name: 'Device diagnostics' })).toBeVisible();
  87  |   await page.clock.fastForward(11000);
  88  |   await page.keyboard.press('Escape');
  89  |   await expect(page.getByRole('heading', { name: 'A softer horizon' })).toBeVisible();
  90  |   await expect(page.locator('#slideshow-status')).toHaveText('Slideshow paused');
  91  |   await page.keyboard.press('Escape');
  92  |   await expect(page.locator('[data-focus-id="photo-coast"]')).toBeFocused();
  93  | });
  94  | 
  95  | test('failed local images show a bounded fallback and retain keyboard navigation', async ({ page }) => {
  96  |   await page.route('**/assets/photos/coast.svg', (route) => route.abort());
  97  |   await openCollection(page);
  98  |   await expect(page.locator('[data-focus-id="photo-coast"] .image-fallback')).toBeVisible();
  99  |   await page.keyboard.press('Enter');
  100 |   await expect(page.locator('.full-photo .image-fallback')).toBeVisible();
  101 |   await page.keyboard.press('ArrowRight');
  102 |   await expect(page.getByRole('heading', { name: 'A softer horizon' })).toBeVisible();
  103 |   await expect(page.locator('.full-photo')).toHaveClass(/loaded/);
  104 | });
  105 | 
```