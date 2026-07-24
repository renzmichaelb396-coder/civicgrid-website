import { test, expect, chromium, type Page, type Route } from '@playwright/test';

/**
 * TDD chaos suite for the CivicGrid marketing site (static HTML, Formspree contact form).
 * Runs against https://www.civicgrid.dev (see playwright.config.ts baseURL).
 *
 * Only the "valid submit" happy-path test hits the real Formspree endpoint
 * (https://formspree.io/f/xrenylap) — it uses clearly-labeled QA data so it's
 * identifiable in the site owner's inbox/lead dashboard. Every other form test
 * (double-click, 5000-char, injection) mocks the endpoint via page.route so the
 * chaos/stress variants don't create junk leads on every test run.
 */

const FORMSPREE_URL = 'https://formspree.io/f/xrenylap';
const NAV_ANCHORS = ['#hero', '#products', '#why', '#serve', '#contact'];
const BASE_URL = process.env.CIVICGRID_BASE_URL || 'https://www.civicgrid.dev';

async function fillValidForm(page: Page, overrides: Partial<{
  fullName: string;
  agency: string;
  email: string;
  product: string;
  challenge: string;
}> = {}) {
  const data = {
    fullName: 'Playwright QA Test',
    agency: 'CivicGrid QA Automation',
    email: 'qa-automation@civicgrid.dev',
    product: 'RoadSense',
    challenge: '',
    ...overrides,
  };
  await page.locator('#fullName').fill(data.fullName);
  await page.locator('#agency').fill(data.agency);
  await page.locator('#email').fill(data.email);
  await page.locator('#product').selectOption(data.product);
  if (data.challenge) await page.locator('#challenge').fill(data.challenge);
  return data;
}

async function mockFormspreeSuccess(page: Page, delayMs = 0) {
  const calls: Route[] = [];
  await page.route(FORMSPREE_URL, async (route) => {
    calls.push(route);
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true }),
    });
  });
  return calls;
}

function countFormspreeRequests(page: Page): { count: () => number } {
  let n = 0;
  page.on('request', (req) => {
    if (req.url() === FORMSPREE_URL) n++;
  });
  return { count: () => n };
}

test.describe('Phase 1 — Contact form', () => {
  test('empty required fields block submit with zero network calls', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'single-browser functional check');
    await page.goto('/');
    const counter = countFormspreeRequests(page);
    await page.locator('.form-submit').click();
    await page.waitForTimeout(500);
    expect(counter.count()).toBe(0);
    expect(await page.locator('#formSuccess').evaluate((el) => el.classList.contains('show'))).toBe(false);
    for (const id of ['#fullName', '#agency', '#email']) {
      expect(await page.locator(id).evaluate((el: HTMLInputElement) => el.validity.valid)).toBe(false);
    }
  });

  test('invalid email format is blocked client-side', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'single-browser functional check');
    await page.goto('/');
    await fillValidForm(page, { email: 'not-an-email' });
    const counter = countFormspreeRequests(page);
    await page.locator('.form-submit').click();
    await page.waitForTimeout(500);
    expect(counter.count()).toBe(0);
    expect(await page.locator('#email').evaluate((el: HTMLInputElement) => el.validity.valid)).toBe(false);
    expect(await page.locator('#formSuccess').evaluate((el) => el.classList.contains('show'))).toBe(false);
  });

  test('valid submit hits real Formspree endpoint, returns 200, shows visible success UI', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'single-browser functional check; hits real production endpoint');
    await page.goto('/');
    await fillValidForm(page);
    const [response] = await Promise.all([
      page.waitForResponse((r) => r.url() === FORMSPREE_URL),
      page.locator('.form-submit').click(),
    ]);
    expect(response.status()).toBe(200);
    await expect(page.locator('#formSuccess')).toHaveClass(/show/);
    await expect(page.locator('#formSuccess')).toBeVisible();
    expect(await page.locator('#formSuccess').textContent()).not.toMatch(/mailto:/i);
    // Not a silent mailto fallback — the page never navigates away from the site under test.
    expect(new URL(page.url()).origin).toBe(new URL(BASE_URL).origin);
  });

  test('rapid double-click submit does not fire duplicate network calls', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'single-browser functional check');
    await page.goto('/');
    await fillValidForm(page);
    await mockFormspreeSuccess(page, 300);
    const counter = countFormspreeRequests(page);
    await page.locator('.form-submit').dblclick();
    await page.waitForTimeout(800);
    expect(counter.count()).toBe(1);
  });

  test('5000+ char challenge textarea submits or truncates gracefully, no crash', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'single-browser functional check');
    const pageErrors: Error[] = [];
    page.on('pageerror', (err) => pageErrors.push(err));
    await page.goto('/');
    const longText = 'A'.repeat(5200);
    await fillValidForm(page, { challenge: longText });
    await mockFormspreeSuccess(page);
    const [response] = await Promise.all([
      page.waitForResponse((r) => r.url() === FORMSPREE_URL),
      page.locator('.form-submit').click(),
    ]);
    expect(response.status()).toBe(200);
    expect(pageErrors).toHaveLength(0);
    // graceful either way: success UI shown, no blank/crashed page
    await expect(page.locator('#formSuccess')).toHaveClass(/show/);
  });
});

test.describe('Phase 2 — Content regression', () => {
  test('page text does not contain "active pilot alignment"', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'single-browser content check');
    await page.goto('/');
    const bodyText = (await page.locator('body').innerText()).toLowerCase();
    expect(bodyText).not.toContain('active pilot alignment');
  });

  test('InfraWatch section contains zero peso figures or Projects/Active/Alerts/Ghost stat counts', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'single-browser content check');
    await page.goto('/');
    const card = page.locator('.product-card', { has: page.locator('.product-title', { hasText: 'InfraWatch' }) });
    await expect(card).toHaveCount(1);
    const cardText = await card.innerText();
    expect(cardText).not.toMatch(/₱|P\d[\d,.]*\s*[BMK]?\b/);
    expect(cardText).not.toMatch(/\bProjects\b/);
    expect(cardText).not.toMatch(/\bActive\b/);
    expect(cardText).not.toMatch(/\bAlerts\b/);
    expect(cardText).not.toMatch(/\bGhost\b/);
  });

  test('EOC section contains "Live" and "UAT Accepted"', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'single-browser content check');
    await page.goto('/');
    const card = page.locator('.product-card', { has: page.locator('.product-title', { hasText: 'EOC' }) });
    await expect(card).toHaveCount(1);
    const cardText = await card.innerText();
    expect(cardText).toMatch(/Live/);
    expect(cardText).toMatch(/UAT Accepted/);
  });

  test('all [data-count] hero counters show their target values within 3s, no scroll', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'single-browser content check');
    await page.goto('/');
    const counters = page.locator('[data-count]');
    const total = await counters.count();
    expect(total).toBeGreaterThan(0);
    for (let i = 0; i < total; i++) {
      const el = counters.nth(i);
      const target = await el.getAttribute('data-count');
      const suffix = (await el.getAttribute('data-suffix')) || '';
      await expect(el).toHaveAttribute('data-animated', 'true', { timeout: 3000 });
      await expect(el).toHaveText(`${target}${suffix}`, { timeout: 3000 });
    }
  });

  test('prefers-reduced-motion: counters show final value instantly, reveal elements visible with no transform offset', async ({ browser, browserName }) => {
    test.skip(browserName !== 'chromium', 'single-browser content check');
    const context = await browser.newContext({ reducedMotion: 'reduce', baseURL: BASE_URL });
    const page = await context.newPage();
    await page.goto('/');
    const counters = page.locator('[data-count]');
    const total = await counters.count();
    for (let i = 0; i < total; i++) {
      const el = counters.nth(i);
      const target = await el.getAttribute('data-count');
      const suffix = (await el.getAttribute('data-suffix')) || '';
      await expect(el).toHaveText(`${target}${suffix}`, { timeout: 1500 });
    }
    const reveals = page.locator('.reveal');
    const revealCount = await reveals.count();
    expect(revealCount).toBeGreaterThan(0);
    for (let i = 0; i < revealCount; i++) {
      const style = await reveals.nth(i).evaluate((el) => {
        const cs = getComputedStyle(el);
        return { opacity: cs.opacity, transform: cs.transform };
      });
      expect(style.opacity).toBe('1');
      expect(['none', 'matrix(1, 0, 0, 1, 0, 0)']).toContain(style.transform);
    }
    await context.close();
  });
});

test.describe('Phase 3 — Injection', () => {
  test('<script>alert(1)</script> in text fields never fires an alert', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'single-browser security check');
    await page.goto('/');
    let dialogFired = false;
    page.on('dialog', async (dialog) => {
      dialogFired = true;
      await dialog.dismiss();
    });
    await mockFormspreeSuccess(page);
    await fillValidForm(page, {
      fullName: '<script>alert(1)</script>',
      agency: '<img src=x onerror=alert(1)>',
      challenge: '<script>alert(document.domain)</script>',
    });
    await Promise.all([
      page.waitForResponse((r) => r.url() === FORMSPREE_URL),
      page.locator('.form-submit').click(),
    ]);
    await page.waitForTimeout(500);
    expect(dialogFired).toBe(false);
    // page still functional, not replaced by an injected/broken document
    await expect(page.locator('h1')).toBeVisible();
  });

  test('SQLi-shaped string in email/agency fields is treated as plain text, no server error', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'single-browser security check');
    const pageErrors: Error[] = [];
    page.on('pageerror', (err) => pageErrors.push(err));
    await page.goto('/');
    const sqli = "' OR '1'='1'; DROP TABLE users;--";
    await mockFormspreeSuccess(page);
    // SQLi string in the email field is not a valid email — native validation blocks it,
    // which is itself correct "treated as plain text, rejected" behavior for that field.
    await fillValidForm(page, { email: 'not-an-email' + sqli, agency: sqli });
    const counter = countFormspreeRequests(page);
    await page.locator('.form-submit').click();
    await page.waitForTimeout(500);
    expect(counter.count()).toBe(0); // blocked client-side by email format validation
    expect(pageErrors).toHaveLength(0);

    // Now confirm the agency field (plain text, no format constraint) accepts and
    // transmits the SQLi-shaped string as inert plain text with no crash.
    await fillValidForm(page, { agency: sqli });
    const [response] = await Promise.all([
      page.waitForResponse((r) => r.url() === FORMSPREE_URL),
      page.locator('.form-submit').click(),
    ]);
    expect(response.status()).toBe(200);
    expect(pageErrors).toHaveLength(0);
    await expect(page.locator('#formSuccess')).toHaveClass(/show/);
  });
});

test.describe('Phase 4 — Structural / rendering', () => {
  test('zero console errors on load', async ({ page, browserName }) => {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    page.on('pageerror', (err) => errors.push(err.message));
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    expect(errors, `console/page errors on ${browserName}: ${JSON.stringify(errors)}`).toHaveLength(0);
  });

  test('Lighthouse mobile performance >= 90', async ({ browserName }) => {
    test.skip(browserName !== 'chromium', 'lighthouse requires a CDP-attached chromium instance');
    const { playAudit } = await import('playwright-lighthouse');
    const port = 9223;
    const browser = await chromium.launch({ args: [`--remote-debugging-port=${port}`] });
    const page = await browser.newPage();
    await page.goto('https://www.civicgrid.dev');
    try {
      await playAudit({
        page,
        port,
        thresholds: { performance: 90 },
        opts: { formFactor: 'mobile', screenEmulation: { mobile: true, width: 375, height: 667, deviceScaleFactor: 2 } },
      });
    } finally {
      await browser.close();
    }
  });

  for (const viewport of [
    { width: 1440, height: 900, label: '1440px' },
    { width: 768, height: 1024, label: '768px' },
    { width: 375, height: 812, label: '375px' },
  ]) {
    test(`at ${viewport.label}: hero H1 not clipped by nav, no horizontal scroll`, async ({ page, browserName }) => {
      test.skip(browserName !== 'chromium', 'single-browser layout check');
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto('/');
      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
      expect(scrollWidth, `horizontal scroll at ${viewport.label}`).toBeLessThanOrEqual(clientWidth + 1);

      const navBox = await page.locator('nav#navbar').boundingBox();
      const h1Box = await page.locator('.hero h1').boundingBox();
      expect(navBox).not.toBeNull();
      expect(h1Box).not.toBeNull();
      if (navBox && h1Box) {
        expect(h1Box.y, `H1 top overlaps nav bottom at ${viewport.label}`).toBeGreaterThanOrEqual(navBox.y + navBox.height - 1);
      }
    });
  }

  test('every internal nav anchor resolves to a real element on the page', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'single-browser structural check');
    await page.goto('/');
    for (const anchor of NAV_ANCHORS) {
      const target = page.locator(anchor);
      await expect(target, `anchor ${anchor} does not resolve to an element`).toHaveCount(1);
    }
  });

  test('og:image and twitter:card meta tags — known-missing until Packet B ships', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'single-browser meta check');
    await page.goto('/');
    const ogImage = await page.locator('meta[property="og:image"]').count();
    const twitterCard = await page.locator('meta[name="twitter:card"]').count();
    if (ogImage === 0 || twitterCard === 0) {
      test.info().annotations.push({
        type: 'known-issue',
        description: `og:image present=${ogImage > 0}, twitter:card present=${twitterCard > 0} — expected missing until Packet B ships. Not a failure.`,
      });
    }
    // Not asserted as a failure — logged as known-missing per Packet B status.
  });

  test('civicgrid.ph reachability — known issue until DNS cutover', async ({ browserName }) => {
    test.skip(browserName !== 'chromium', 'single-browser network check');
    try {
      const res = await fetch('https://civicgrid.ph', { method: 'GET', signal: AbortSignal.timeout(8000) });
      test.info().annotations.push({
        type: 'known-issue',
        description: `civicgrid.ph responded with status ${res.status} — verify against expected DNS cutover state.`,
      });
    } catch (err) {
      test.info().annotations.push({
        type: 'known-issue',
        description: `civicgrid.ph unreachable (expected until DNS cutover): ${(err as Error).message}`,
      });
    }
    // Intentionally not asserted — expected FAIL until DNS cutover, logged not failed.
  });
});
