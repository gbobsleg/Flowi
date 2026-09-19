'use strict';

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const e2eEnabled = process.env.NODE_ENV === 'test' && !!process.env.DATABASE_URL;
if (e2eEnabled) {
  require('../helpers/guard').assertSafeTestDatabase();
}

const DEFAULT_TIMEOUT_MS = 10_000;

function directoryRow(page, matricule) {
  return page.locator('tr', { has: page.getByText(matricule, { exact: true }) });
}

describe('Clics superviseur', { skip: !e2eEnabled }, () => {
  let helpers;
  let ctx;
  let offerId;
  let browser;
  let context;
  let page;

  before(async () => {
    const { chromium } = require('playwright');
    helpers = require('../helpers/app');
    ctx = await helpers.startTestApp();
    browser = await chromium.launch({ headless: true });
  });

  after(async () => {
    if (browser) {
      await browser.close();
      browser = null;
    }
    if (helpers && ctx) await helpers.stopTestApp(ctx);
  });

  beforeEach(async () => {
    const seeded = await helpers.resetDb();
    offerId = seeded.offerId;
    context = await browser.newContext();
    context.setDefaultTimeout(DEFAULT_TIMEOUT_MS);
    page = await context.newPage();
  });

  afterEach(async () => {
    try {
      if (page) await page.close();
    } finally {
      page = null;
      if (context) {
        await context.close();
        context = null;
      }
    }
  });

  it('Ignorer une pause remet 15 min dans l’annuaire', async () => {
    await helpers.insertEndedPause({
      matricule: 'MAT_T1',
      offerId,
      durationSeconds: 15 * 60,
    });

    await helpers.loginSupervisorInBrowser(page, ctx.baseUrl);
    await page.getByRole('button', { name: 'Historique' }).click();
    await page.getByRole('button', { name: 'Ignorer' }).waitFor({ state: 'visible' });

    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: 'Ignorer' }).click();
    await page.getByRole('button', { name: 'Rétablir' }).waitFor({ state: 'visible' });

    await page.getByRole('button', { name: 'Annuaire' }).click();
    const row = directoryRow(page, 'MAT_T1');
    await row.waitFor({ state: 'visible' });
    await row.getByText('15 min', { exact: true }).waitFor({ state: 'visible' });
    assert.equal(await row.getByText('15 min', { exact: true }).count(), 1);
  });

  it('Ajouter une plage loin de maintenant affiche Hors plage', async () => {
    const [windowFar] = helpers.closedWindowsFarFromNow();

    await helpers.loginSupervisorInBrowser(page, ctx.baseUrl);
    await page.getByRole('button', { name: 'Paramètres' }).click();
    await page.getByRole('heading', { name: 'Fenêtres de pause autorisées' }).waitFor({ state: 'visible' });

    const section = page.locator('section', {
      has: page.getByRole('heading', { name: 'Fenêtres de pause autorisées' }),
    });
    await section.locator('input[type="time"]').nth(0).fill(windowFar.start);
    await section.locator('input[type="time"]').nth(1).fill(windowFar.end);
    await section.getByRole('button', { name: 'Ajouter' }).click();
    await page.getByText('Plages enregistrées.').waitFor({ state: 'visible' });

    await page.getByRole('button', { name: 'Annuaire' }).click();
    const row = directoryRow(page, 'MAT_T1');
    await row.waitFor({ state: 'visible' });
    await row.getByText('Hors plage').first().waitFor({ state: 'visible' });
    assert.equal(await row.getByText('Hors plage', { exact: true }).count(), 2);
  });
});
