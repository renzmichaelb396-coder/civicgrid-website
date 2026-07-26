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
const NAV_ANCHORS = ['#hero', '#eoc', '#why', '#serve', '#contact'];
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
    product: 'EOC',
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

  test('contact form product select includes an "EOC" option', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'single-browser structural check');
    await page.goto('/');
    const options = await page.locator('#product option').allTextContents();
    expect(options).toContain('EOC');
    await page.locator('#product').selectOption('EOC');
    expect(await page.locator('#product').inputValue()).toBe('EOC');
  });
});

test.describe('Phase 2 — Content regression', () => {
  test('page text does not contain "active pilot alignment"', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'single-browser content check');
    await page.goto('/');
    const bodyText = (await page.locator('body').innerText()).toLowerCase();
    expect(bodyText).not.toContain('active pilot alignment');
  });

  // InfraWatch was discontinued and removed from the site entirely (no market interest;
  // its stats — 421 Ghost Projects Flagged / P138B COA-flagged — were invented, not real).
  // This asserts it stays gone: no card, no lingering "InfraWatch" text anywhere in the DOM.
  test('InfraWatch is absent from the page entirely', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'single-browser content check');
    await page.goto('/');
    const bodyText = await page.locator('body').innerText();
    expect(bodyText).not.toMatch(/InfraWatch/i);
    await expect(page.locator('.product-card', { has: page.locator('.product-title', { hasText: 'InfraWatch' }) })).toHaveCount(0);
    const productOptions = await page.locator('#product option').allTextContents();
    expect(productOptions.join(' ')).not.toMatch(/InfraWatch/i);
  });

  // RoadSense was removed from the marketing site (website-only; the product itself keeps
  // running unchanged at its own deployment). Unlike InfraWatch, "RoadSense" isn't fully
  // banned text — the IPOPHL filing is legally named "RoadSense EOC System" and that exact
  // wording stays in the founder bio and milestone card. This asserts RoadSense is gone from
  // every other surface (no card, no #products section, no form option, no nav/footer link)
  // and that the only remaining mentions are exactly those two legitimate filing references.
  test('RoadSense is absent from the page except the IPOPHL filing name in founder bio/milestone', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'single-browser content check');
    await page.goto('/');
    await expect(page.locator('#products')).toHaveCount(0);
    await expect(page.locator('.product-card', { has: page.locator('.product-title', { hasText: 'RoadSense' }) })).toHaveCount(0);
    const productOptions = await page.locator('#product option').allTextContents();
    expect(productOptions.join(' ')).not.toMatch(/RoadSense/i);
    await expect(page.locator('.nav-links a[href="#products"]')).toHaveCount(0);
    await expect(page.locator('.footer-links a[href="#products"]')).toHaveCount(0);

    const bodyText = await page.locator('body').innerText();
    const totalMentions = (bodyText.match(/RoadSense/gi) || []).length;
    const founderBioText = await page.locator('.founder-bio').innerText();
    const milestoneText = await page
      .locator('.milestone-item', { has: page.locator('.milestone-body', { hasText: '2026-04892' }) })
      .innerText();
    const expectedMentions =
      (founderBioText.match(/RoadSense/gi) || []).length + (milestoneText.match(/RoadSense/gi) || []).length;
    expect(totalMentions).toBe(expectedMentions);
  });

  // IPOPHL ref. 2026-04892 is a Copyright Registration Application (Bureau of Copyright
  // and Related Rights), currently tagged "For Verification" — not a trademark, not granted.
  test('IPOPHL milestone accurately describes a copyright application under verification, not a trademark', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'single-browser content check');
    await page.goto('/');
    const milestones = page.locator('.milestone-item', { has: page.locator('.milestone-body', { hasText: '2026-04892' }) });
    await expect(milestones).toHaveCount(1);
    const milestoneText = await milestones.innerText();
    expect(milestoneText).not.toMatch(/Trademark/i);
    expect(milestoneText).toMatch(/Copyright/i);
    expect(milestoneText).toMatch(/For Verification/i);
  });

  // The founder bio references the same IPOPHL filing as the milestone card above and
  // must agree with it: no "Trademark", no claim of grant/approval, scoped to RoadSense EOC.
  test('founder bio IP wording matches the milestone section — no trademark claim, no overstated status', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'single-browser content check');
    await page.goto('/');
    const bio = page.locator('.founder-bio');
    await expect(bio).toHaveCount(1);
    const bioText = await bio.innerText();
    expect(bioText).toMatch(/IPOPHL/);
    expect(bioText).not.toMatch(/Trademark/i);
    expect(bioText).not.toMatch(/\bgranted\b/i);
    expect(bioText).not.toMatch(/\bapproved\b/i);
    expect(bioText).toMatch(/Copyright/i);
    expect(bioText).not.toMatch(/national agencies/i);
    expect(bioText).not.toMatch(/accountability/i);
    expect(bioText).not.toMatch(/field-first/i);
  });

  test('EOC section (promoted, full section) contains "Live" and UAT-accepted status', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'single-browser content check');
    await page.goto('/');
    const section = page.locator('section#eoc');
    await expect(section).toHaveCount(1);
    const sectionText = await section.innerText();
    expect(sectionText).toMatch(/Live/);
    expect(sectionText).toMatch(/UAT.?accepted/i);
    expect(sectionText).toMatch(/Mandaluyong City CDRRMD/);
  });

  test('hero leads with EOC positioning (verbatim packet copy)', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'single-browser content check');
    await page.goto('/');
    const h1 = await page.locator('.hero h1').innerText();
    expect(h1).toContain('Emergency Operations Infrastructure');
    const badge = await page.locator('.hero-badge').innerText();
    expect(badge).toContain('Mandaluyong City CDRRMD');
    const subtitle = await page.locator('.hero-subtitle').innerText();
    expect(subtitle).toContain('tamper-proof chain of custody');
    expect(subtitle).toContain('Live in production today, not a pilot');
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

  test('og:image and twitter:card meta tags present, image path resolves', async ({ page, browserName, request }) => {
    test.skip(browserName !== 'chromium', 'single-browser meta check');
    await page.goto('/');
    const ogImageContent = await page.locator('meta[property="og:image"]').getAttribute('content');
    const twitterCard = await page.locator('meta[name="twitter:card"]').getAttribute('content');
    expect(ogImageContent, 'og:image meta tag must be present').toBeTruthy();
    expect(twitterCard).toBe('summary_large_image');
    // og:image is intentionally an absolute production URL (required for social-preview
    // scrapers, and matches the existing og:url pattern) — this resolves against prod
    // regardless of which BASE_URL is under test, which is the correct check for a tag
    // that must work when a real platform scrapes the canonical URL.
    const res = await request.get(ogImageContent!);
    expect(res.ok(), `og:image ${ogImageContent} must resolve — asset needs to be placed in repo root and deployed`).toBeTruthy();
  });

  test('#eoc section exists and contains the real dashboard image (not the shared CSS mock chrome)', async ({ page, browserName, request }) => {
    test.skip(browserName !== 'chromium', 'single-browser structural check');
    await page.goto('/');
    const eocSection = page.locator('section#eoc');
    await expect(eocSection).toHaveCount(1);
    const img = eocSection.locator('img.eoc-dashboard-img');
    await expect(img, 'EOC section must use a real <img>, not .product-preview mock-dashboard chrome').toHaveCount(1);
    expect(await eocSection.locator('.window-controls').count(), 'EOC section must not reuse the shared CSS mock-dashboard chrome').toBe(0);
    const src = await img.getAttribute('src');
    expect(src).toBeTruthy();
    const resolved = new URL(src!, page.url()).toString();
    const res = await request.get(resolved);
    expect(res.ok(), `EOC dashboard image (${resolved}) must resolve — asset needs to be placed in repo root and deployed`).toBeTruthy();
  });

  test('EOC nav anchor exists in nav and footer, and resolves to the #eoc section', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'single-browser structural check');
    await page.goto('/');
    await expect(page.locator('.nav-links a[href="#eoc"]')).toHaveCount(1);
    await expect(page.locator('.footer-links a[href="#eoc"]')).toHaveCount(1);
    await expect(page.locator('section#eoc')).toHaveCount(1);
  });

  test('RA 10173 privacy statement present with real contact info', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'single-browser content check');
    await page.goto('/');
    const privacy = page.locator('#privacy');
    await expect(privacy).toHaveCount(1);
    const text = await privacy.innerText();
    expect(text).toMatch(/Data Privacy Act|RA 10173/i);
    expect(text).toMatch(/geolocation/i);
    expect(text).toMatch(/contact@civicgrid\.dev/);
  });

  test('fresh load, no scroll: hero h1 fully revealed within 3s, ≥1 hero stat counter non-zero', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'single-browser reveal check');
    await page.goto('/');
    await expect
      .poll(() => page.locator('.hero h1').evaluate((el) => getComputedStyle(el).opacity), { timeout: 3000 })
      .toBe('1');
    // One hero counter ("Untraceable Incident Records") is deliberately 0 — assert
    // that at least one of the others has animated to a non-zero value.
    await expect
      .poll(async () => {
        const texts = await page.locator('.hero-stats [data-count]').allTextContents();
        return texts.filter((t) => /[1-9]/.test(t)).length;
      }, { timeout: 3000 })
      .toBeGreaterThan(0);
  });

  // Encodes the 2026-07-23 hidden-tab failure mode: a page loaded in a background tab
  // defers IntersectionObserver callbacks, so in-viewport .reveal elements sit at
  // opacity 0 until the visibilitychange/pageshow fallback runs. Playwright cannot
  // genuinely background-load a tab (headless pages always render as visible), so this
  // emulates the two observable properties of that state before any page script runs:
  // document.visibilityState reports 'hidden', and IO callbacks are never delivered.
  // The pre-flip assertion (hero still at opacity 0) keeps the test non-vacuous — if
  // the emulation stopped reproducing the failure mode, that assertion fails, and if
  // the fallback handler were removed, the post-flip assertion fails.
  test('hidden-tab load: hero stays hidden while backgrounded, reveals within 3s of tab becoming visible', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'single-browser reveal check');
    await page.addInitScript(() => {
      (window as unknown as { __visState: string }).__visState = 'hidden';
      const state = () => (window as unknown as { __visState: string }).__visState;
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: state });
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => state() === 'hidden' });
      // Background tabs defer IO callbacks until first render — emulate by never delivering them.
      (window as unknown as { IntersectionObserver: unknown }).IntersectionObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
        takeRecords() { return []; }
      };
    });
    await page.goto('/');
    await page.waitForTimeout(1000);
    expect(await page.locator('.hero h1').evaluate((el) => getComputedStyle(el).opacity)).toBe('0');
    await page.evaluate(() => {
      (window as unknown as { __visState: string }).__visState = 'visible';
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect
      .poll(() => page.locator('.hero h1').evaluate((el) => getComputedStyle(el).opacity), { timeout: 3000 })
      .toBe('1');
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

/**
 * Phase A — 2026-07 design-compliance packet
 * (CIVICGRID-WEBSITE-DESIGN-COMPLIANCE-PHASE-A-PACKET.md)
 * Asserts exact computed styles / absences, not just "renders".
 */
test.describe('Phase A — Design compliance', () => {
  const EASE = 'cubic-bezier(0.16, 1, 0.3, 1)';
  const ACCENT_RGB = 'rgb(242, 166, 24)'; // #F2A618 civic-amber (oklch(78% 0.16 75)), solid

  test('source: zero gradients, zero backdrop-filter, zero banned hex, no 100px radius, mono font loaded', async ({ page, browserName, request }) => {
    test.skip(browserName !== 'chromium', 'single-browser source audit');
    const res = await request.get('/');
    const html = await res.text();
    expect(html).not.toMatch(/linear-gradient|radial-gradient/i);
    expect(html).not.toMatch(/backdrop-filter/i);
    expect(html).not.toMatch(/border-radius:\s*100px/);
    for (const banned of ['#b8943e', '#e8d48b', '#e0c068', '#EF9F27', '#FAC775', '#5DCAA5', '#10b981', '#C9A84C']) {
      expect(html.toLowerCase(), `banned hex ${banned} present in source`).not.toContain(banned.toLowerCase());
    }
    // #C9A84C (legacy accent) is fully retired — civic-amber is #F2A618, civic-amber-deep #D08600.
    const fontLinks = html.match(/fonts\.googleapis\.com\/css2\?[^"]+/g) || [];
    expect(fontLinks.length).toBeGreaterThan(0);
    for (const link of fontLinks) {
      expect(link, 'every Google Fonts stylesheet URL must load IBM Plex Mono').toContain('IBM+Plex+Mono');
    }
  });

  test('rendered body text contains at most 2 em-dashes', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'single-browser content audit');
    await page.goto('/');
    const bodyText = await page.locator('body').innerText();
    const emDashes = (bodyText.match(/—/g) || []).length;
    expect(emDashes, `em-dash budget exceeded: found ${emDashes}`).toBeLessThanOrEqual(2);
  });

  test('.hero-badge: rectangular radius (4px or 8px), not a 100px/50% pill', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'single-browser computed-style check');
    await page.goto('/');
    const radius = await page.locator('.hero-badge').evaluate((el) => getComputedStyle(el).borderRadius);
    expect(['100px', '50%']).not.toContain(radius);
    expect(['4px', '8px']).toContain(radius);
  });

  test('.hero-badge .pulse-dot: no #10b981 green, uses brand accent', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'single-browser computed-style check');
    await page.goto('/');
    const bg = await page.locator('.hero-badge .pulse-dot').evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).not.toBe('rgb(16, 185, 129)');
    expect(bg).toBe(ACCENT_RGB);
  });

  test('nav: backdrop-filter is none in default, scrolled, and mobile drawer states', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'single-browser computed-style check');
    await page.goto('/');
    const bf = (el: Element) => {
      const cs = getComputedStyle(el);
      return cs.backdropFilter || (cs as unknown as { webkitBackdropFilter: string }).webkitBackdropFilter || 'none';
    };
    expect(await page.locator('nav#navbar').evaluate(bf)).toBe('none');
    await page.evaluate(() => window.scrollTo(0, 600));
    await expect(page.locator('nav#navbar')).toHaveClass(/scrolled/);
    expect(await page.locator('nav#navbar').evaluate(bf)).toBe('none');
    // mobile drawer
    await page.setViewportSize({ width: 375, height: 812 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.locator('#hamburger').click();
    await expect(page.locator('#navLinks')).toHaveClass(/active/);
    expect(await page.locator('#navLinks').evaluate(bf)).toBe('none');
  });

  test('.hero h1 weight 600, .gold is solid accent with no gradient text fill', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'single-browser computed-style check');
    await page.goto('/');
    expect(await page.locator('.hero h1').evaluate((el) => getComputedStyle(el).fontWeight)).toBe('600');
    const gold = await page.locator('.hero h1 .gold').evaluate((el) => {
      const cs = getComputedStyle(el);
      return { backgroundImage: cs.backgroundImage, color: cs.color, fill: cs.webkitTextFillColor };
    });
    expect(gold.backgroundImage).toBe('none');
    expect(gold.color).toBe(ACCENT_RGB);
    expect(gold.fill).not.toBe('rgba(0, 0, 0, 0)'); // no transparent text-fill gradient trick
  });

  test('every .section-title has font-weight 600 (was 800)', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'single-browser computed-style check');
    await page.goto('/');
    const titles = page.locator('.section-title');
    const n = await titles.count();
    expect(n).toBeGreaterThan(0);
    for (let i = 0; i < n; i++) {
      expect(await titles.nth(i).evaluate((el) => getComputedStyle(el).fontWeight)).toBe('600');
    }
  });

  test('why/serve: old identical icon+h3+p card selectors gone; all 6 Why + 4 Serve texts preserved', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'single-browser structural check');
    await page.goto('/');
    for (const dead of ['.why-grid', '.why-card', '.why-card-icon', '.serve-cards', '.serve-card', '.serve-card-icon']) {
      await expect(page.locator(dead), `${dead} must no longer match`).toHaveCount(0);
    }
    await expect(page.locator('#why .why-item')).toHaveCount(6);
    await expect(page.locator('#serve .serve-item')).toHaveCount(4);
    const bodyText = await page.locator('body').innerText();
    for (const t of [
      'Built for Philippine Government Workflows',
      'Field-First, Not Dashboard-First',
      'Audit-Ready by Default',
      'Structural Prevention, Not Detection',
      'Offline-Capable Mobile App',
      'Pilot-Ready in 30 Days',
      'Local Government Units',
      'Government Agencies',
      'Private Developers',
      'NGOs & Development Partners',
    ]) {
      expect(bodyText, `point "${t}" missing after restructure`).toContain(t);
    }
    // point bodies survive too (distinctive fragments, avoiding the de-em-dashed spans)
    for (const frag of [
      'local procurement rules',
      'capture verified evidence before anything reaches a dashboard',
      'COA-ready evidence record',
      'reviewable after the fact',
      'syncing when connection is restored',
      'clear success metrics',
      'road and infrastructure programs',
      'district or national level',
      'contractor accountability',
      'auditable project records',
    ]) {
      expect(bodyText, `point body fragment "${frag}" missing after restructure`).toContain(frag);
    }
  });

  test('founder card: no #5DCAA5 mint on border, title, milestone dots/dates', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'single-browser computed-style check');
    await page.goto('/');
    const MINT = 'rgb(93, 202, 165)';
    const border = await page.locator('.founder-card').evaluate((el) => getComputedStyle(el).borderColor);
    expect(border).not.toBe(MINT);
    expect(await page.locator('.founder-title').evaluate((el) => getComputedStyle(el).color)).not.toBe(MINT);
    const dots = page.locator('.milestone-dot');
    for (let i = 0; i < (await dots.count()); i++) {
      expect(await dots.nth(i).evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(MINT);
    }
    const dates = page.locator('.milestone-date');
    for (let i = 0; i < (await dates.count()); i++) {
      expect(await dates.nth(i).evaluate((el) => getComputedStyle(el).color)).not.toBe(MINT);
    }
  });

  test('CTA buttons: solid civic-amber, background-image none', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'single-browser computed-style check');
    await page.goto('/');
    for (const sel of ['.hero-buttons .btn-primary', '.product-button .btn-primary', '.btn-demo']) {
      const cta = await page.locator(sel).first().evaluate((el) => {
        const cs = getComputedStyle(el);
        return { backgroundImage: cs.backgroundImage, backgroundColor: cs.backgroundColor };
      });
      expect(cta.backgroundImage, `${sel} still has a background-image`).toBe('none');
      expect(cta.backgroundColor, `${sel} not solid civic-amber`).toBe(ACCENT_RGB);
    }
    // form submit + back-to-top also de-gradiented
    expect(await page.locator('.form-submit').evaluate((el) => getComputedStyle(el).backgroundImage)).toBe('none');
    expect(await page.locator('.back-to-top').evaluate((el) => getComputedStyle(el).backgroundImage)).toBe('none');
  });

  // .map-pin has no live DOM instances (leftover component CSS), so computed style can't be
  // queried on elements — assert against the stylesheet rules themselves so the check is
  // non-vacuous and survives the pins being re-instantiated later.
  test('map pin rules: severity colors are oklch (no raw #ef4444/#f97316/#eab308), no glow box-shadow', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'single-browser stylesheet check');
    await page.goto('/');
    const rules = await page.evaluate(() => {
      const out: string[] = [];
      for (const sheet of Array.from(document.styleSheets)) {
        let list: CSSRuleList;
        try { list = sheet.cssRules; } catch { continue; }
        for (const rule of Array.from(list)) {
          if (rule.cssText.includes('.map-pin')) out.push(rule.cssText);
        }
      }
      return out;
    });
    expect(rules.length, 'expected .map-pin rules in the stylesheet').toBeGreaterThan(0);
    const joined = rules.join('\n');
    expect(joined).not.toMatch(/#ef4444|#f97316|#eab308/i);
    expect(joined).not.toMatch(/rgb\(239,\s*68,\s*68\)|rgb\(249,\s*115,\s*22\)|rgb\(234,\s*179,\s*8\)/);
    expect(joined).toMatch(/oklch\(/);
    expect(joined, '.map-pin must not carry a glow box-shadow').not.toMatch(/box-shadow/);
  });

  test('transition timing on nav/links/cards/inputs/back-to-top is cubic-bezier(0.16,1,0.3,1)', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'single-browser computed-style check');
    await page.goto('/');
    // .problem-card is dead CSS with no DOM instances — cards are covered by .why-item/.serve-item
    for (const sel of [
      'nav#navbar',
      '.nav-links a >> nth=0',
      '.why-item >> nth=0',
      '.serve-item >> nth=0',
      '#fullName',
      '.back-to-top',
      '.footer-links a >> nth=0',
    ]) {
      const tf = await page.locator(sel).evaluate((el) => getComputedStyle(el).transitionTimingFunction);
      expect(tf, `${sel} timing-function drifted`).toBe(EASE);
    }
  });

  test('Mono-Is-Data: DTI/PhilGEPS/IPOPHL reference values render in IBM Plex Mono', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'single-browser computed-style check');
    await page.goto('/');
    const refs = page.locator('.ref-mono');
    await expect(refs).toHaveCount(4); // DTI, PhilGEPS, milestone IPOPHL ref, founder-bio IPOPHL ref
    const texts = await refs.allTextContents();
    expect(texts).toContain('7980659');
    expect(texts).toContain('476941');
    expect(texts.filter((t) => t === '2026-04892')).toHaveLength(2);
    for (let i = 0; i < 4; i++) {
      const ff = await refs.nth(i).evaluate((el) => getComputedStyle(el).fontFamily);
      expect(ff, 'reference value not in the mono data face').toContain('IBM Plex Mono');
    }
  });

  test('scope guard: registration facts, founder bio, and milestone dates byte-identical in rendered text', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'single-browser content guard');
    await page.goto('/');
    const bodyText = await page.locator('body').innerText();
    expect(bodyText).toContain('DTI Reg. No. 7980659');
    expect(bodyText).toContain('PhilGEPS Supplier No. 476941');
    expect(bodyText).toContain('2026-04892');
    const bio = await page.locator('.founder-bio').innerText();
    expect(bio).toBe(
      "Renz Michael Bautista is the founder of CivicGrid Software Development Services, building EOC and emergency-operations software for Philippine local government units. Under his leadership, CivicGrid's EOC platform passed UAT with Mandaluyong City CDRRMD, and the company is PhilGEPS-registered, with a Copyright Registration Application for the RoadSense EOC System (ref. 2026-04892) currently under verification with IPOPHL.",
    );
    const dates = await page.locator('.milestone-date').allTextContents();
    expect(dates.map((d) => d.trim().toUpperCase())).toEqual(['JUNE 2026', 'JUNE 2026', 'JULY 2026']);
  });

  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 768, height: 1024 },
    { width: 375, height: 812 },
  ]) {
    test(`cross-viewport smoke at ${viewport.width}px: no overflow, why/serve restructure holds, screenshot saved`, async ({ page, browserName }) => {
      test.skip(browserName !== 'chromium', 'single-browser layout smoke');
      await page.setViewportSize(viewport);
      await page.goto('/');
      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
      expect(scrollWidth, `horizontal overflow at ${viewport.width}px`).toBeLessThanOrEqual(clientWidth + 1);
      await expect(page.locator('#why .why-item')).toHaveCount(6);
      await expect(page.locator('#serve .serve-item')).toHaveCount(4);
      // no overlap between the first two why items (restructure holds)
      const a = await page.locator('#why .why-item').nth(0).boundingBox();
      const b = await page.locator('#why .why-item').nth(1).boundingBox();
      expect(a).not.toBeNull();
      expect(b).not.toBeNull();
      if (a && b) {
        const horizontallySeparate = a.x + a.width <= b.x + 1 || b.x + b.width <= a.x + 1;
        const verticallySeparate = a.y + a.height <= b.y + 1 || b.y + b.height <= a.y + 1;
        expect(horizontallySeparate || verticallySeparate, `why items overlap at ${viewport.width}px`).toBe(true);
      }
      // Below-fold .reveal elements sit at opacity 0 until scrolled into view, which
      // would leave the full-page screenshot blank — force-reveal for the visual record
      // (the reveal mechanic itself is covered by the dedicated reveal tests above).
      await page.evaluate(() => document.querySelectorAll('.reveal').forEach((el) => el.classList.add('visible')));
      await page.waitForTimeout(900);
      await page.screenshot({ path: `test-results/phase-a-${viewport.width}px.png`, fullPage: true });
    });
  }
});
