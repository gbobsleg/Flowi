'use strict';

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

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

  it('PIN faux affiche Authentification requise puis 1234 ouvre les onglets', async () => {
    await page.goto(`${ctx.baseUrl}/supervisor/`, { waitUntil: 'domcontentloaded', timeout: 10_000 });
    await page.locator('#sv-login-pin').waitFor({ state: 'visible' });

    await page.locator('#sv-login-pin').fill('0000');
    await page.getByRole('button', { name: 'Accéder' }).click();
    await page.getByText('Authentification requise').waitFor({ state: 'visible' });
    await page.getByRole('button', { name: 'Historique' }).waitFor({ state: 'hidden' });
    assert.equal(await page.getByRole('button', { name: 'Historique' }).isVisible(), false);

    await page.locator('#sv-login-pin').fill('1234');
    await page.getByRole('button', { name: 'Accéder' }).click();
    await page.getByRole('button', { name: 'Historique' }).waitFor({ state: 'visible' });
  });

  it('Les onglets Temps réel, Historique et Grille affichent leur écran', async () => {
    await helpers.loginSupervisorInBrowser(page, ctx.baseUrl);

    await page.getByRole('button', { name: 'Temps réel' }).click();
    await page.getByRole('heading', { name: 'Agents en pause — Temps réel' }).waitFor({ state: 'visible' });

    await page.getByRole('button', { name: 'Historique' }).click();
    await page.getByText('Aucun historique disponible.').waitFor({ state: 'visible' });

    await page.getByRole('button', { name: 'Grille' }).click();
    await page.getByRole('heading', { name: 'Grille 15 minutes' }).waitFor({ state: 'visible' });
  });

  it('L’aperçu d’import CSV liste les 3 jours et les activités sans offre', async () => {
    const fixturePath = path.resolve(__dirname, '..', 'fixtures', 'genesys-planning-individuel.anonymized.csv');

    await helpers.loginSupervisorInBrowser(page, ctx.baseUrl);
    await page.getByRole('button', { name: 'Paramètres' }).click();
    await page.getByRole('button', { name: 'Planning' }).click();
    await page.getByRole('heading', { name: 'Importer un planning' }).waitFor({ state: 'visible' });

    await page.locator('input[type="file"]').setInputFiles(fixturePath);
    await page.getByText('3 jours seront remplacés, du 06/10/2026 au 25/12/2026.').waitFor({ state: 'visible' });
    await page.getByText('ACCUR, CESU, REPAS', { exact: true }).waitFor({ state: 'visible' });
  });
});
