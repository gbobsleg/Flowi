'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const httpEnabled = process.env.NODE_ENV === 'test' && !!process.env.DATABASE_URL;
if (httpEnabled) {
  require('../helpers/guard').assertSafeTestDatabase();
}

describe('HTTP pause budget', { skip: !httpEnabled }, () => {
  let helpers;
  let ctx;
  let token;
  let offerId;

  before(async () => {
    helpers = require('../helpers/app');
    ctx = await helpers.startTestApp();
  });

  after(async () => {
    if (helpers && ctx) await helpers.stopTestApp(ctx);
  });

  beforeEach(async () => {
    const seeded = await helpers.resetDb();
    offerId = seeded.offerId;
    token = await helpers.loginSupervisor(ctx.baseUrl);
  });

  it('refuse un départ hors plage (409 OUTSIDE_PAUSE_WINDOW)', async () => {
    const windows = helpers.closedWindowsFarFromNow();
    const put = await helpers.requestJson(ctx.baseUrl, 'PUT', '/api/supervisor/settings/pause-windows', {
      token,
      body: { windows },
    });
    assert.equal(put.status, 200);

    const start = await helpers.requestJson(ctx.baseUrl, 'POST', '/api/agent/pause/start', {
      body: { agent_matricule: 'MAT_T1', offerCode: 'TEST_A' },
    });
    assert.equal(start.status, 409);
    assert.equal(start.json.error.code, 'OUTSIDE_PAUSE_WINDOW');
  });

  it('refuse un départ si le pot de 15 min est épuisé (409 PAUSE_LIMIT_REACHED)', async () => {
    await helpers.insertEndedPause({
      matricule: 'MAT_T1',
      offerId,
      durationSeconds: 15 * 60,
    });

    const start = await helpers.requestJson(ctx.baseUrl, 'POST', '/api/agent/pause/start', {
      body: { agent_matricule: 'MAT_T1', offerCode: 'TEST_A' },
    });
    assert.equal(start.status, 409);
    assert.equal(start.json.error.code, 'PAUSE_LIMIT_REACHED');
    assert.equal(start.json.error.fields.pauseBudget.reason, 'budget');
    assert.equal(start.json.error.fields.pauseBudget.canStart, false);
  });

  it('refuse un second départ si N = 1 (409 PAUSE_LIMIT_REACHED / starts)', async () => {
    const setting = await helpers.requestJson(ctx.baseUrl, 'PUT', '/api/supervisor/settings/max-pauses-per-agent', {
      token,
      body: { maxPauses: 1 },
    });
    assert.equal(setting.status, 200);

    await helpers.insertEndedPause({
      matricule: 'MAT_T1',
      offerId,
      durationSeconds: 60,
    });

    const start = await helpers.requestJson(ctx.baseUrl, 'POST', '/api/agent/pause/start', {
      body: { agent_matricule: 'MAT_T1', offerCode: 'TEST_A' },
    });
    assert.equal(start.status, 409);
    assert.equal(start.json.error.code, 'PAUSE_LIMIT_REACHED');
    assert.equal(start.json.error.fields.pauseBudget.reason, 'starts');
  });

  it('ignore une pause puis autorise un nouveau départ et émet les sockets', async () => {
    const ended = await helpers.insertEndedPause({
      matricule: 'MAT_T1',
      offerId,
      durationSeconds: 15 * 60,
    });

    const blocked = await helpers.requestJson(ctx.baseUrl, 'POST', '/api/agent/pause/start', {
      body: { agent_matricule: 'MAT_T1', offerCode: 'TEST_A' },
    });
    assert.equal(blocked.status, 409);

    const socket = await helpers.connectSupervisorSocket(ctx.baseUrl);
    const creditsP = helpers.waitForEvent(socket, 'directory:credits-updated');

    const patched = await helpers.requestJson(ctx.baseUrl, 'PATCH', `/api/supervisor/pauses/${ended.id}`, {
      token,
      body: { excluded_from_budget: true },
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.json.pause.excluded_from_budget, true);
    assert.equal(patched.json.pauseBudget.canStart, true);
    assert.equal(patched.json.pauseBudget.remainingSeconds, 15 * 60);

    const credits = await creditsP;
    assert.equal(credits.pauseWindowOpen, true);
    assert.equal(credits.emptyBudget.canStart, true);
    socket.close();

    const start = await helpers.requestJson(ctx.baseUrl, 'POST', '/api/agent/pause/start', {
      body: { agent_matricule: 'MAT_T1', offerCode: 'TEST_A' },
    });
    assert.equal(start.status, 201);
    assert.equal(start.json.pauseBudget.canStart, true);
  });

  it('GET /agents expose pauseBudget et pauseWindowOpen', async () => {
    const res = await helpers.requestJson(ctx.baseUrl, 'GET', '/api/supervisor/agents', { token });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.json.agents));
    assert.equal(res.json.agents.length, 2);
    const alice = res.json.agents.find((a) => a.matricule === 'MAT_T1');
    assert.ok(alice);
    assert.equal(alice.pauseWindowOpen, true);
    assert.equal(typeof alice.pauseBudget.remainingSeconds, 'number');
    assert.equal(alice.pauseBudget.canStart, true);
    assert.equal(alice.pauseBudget.maxPauses, null);
  });

  it('PUT pause-windows émet directory:credits-updated avec pauseWindowOpen=false', async () => {
    const socket = await helpers.connectSupervisorSocket(ctx.baseUrl);
    const creditsP = helpers.waitForEvent(socket, 'directory:credits-updated');
    const windows = helpers.closedWindowsFarFromNow();

    const put = await helpers.requestJson(ctx.baseUrl, 'PUT', '/api/supervisor/settings/pause-windows', {
      token,
      body: { windows },
    });
    assert.equal(put.status, 200);

    const credits = await creditsP;
    assert.equal(credits.pauseWindowOpen, false);
    socket.close();
  });

  it('applique le quota d’offre (429 QUOTA_REACHED)', async () => {
    await helpers.db.query(
      'UPDATE quota_rules SET fixed_quota = 1, allowed_percent = NULL WHERE offer_id = $1',
      [offerId]
    );

    const first = await helpers.requestJson(ctx.baseUrl, 'POST', '/api/agent/pause/start', {
      body: { agent_matricule: 'MAT_T1', offerCode: 'TEST_A' },
    });
    assert.equal(first.status, 201);

    const second = await helpers.requestJson(ctx.baseUrl, 'POST', '/api/agent/pause/start', {
      body: { agent_matricule: 'MAT_T2', offerCode: 'TEST_A' },
    });
    assert.equal(second.status, 429);
    assert.equal(second.json.error.code, 'QUOTA_REACHED');
  });
});
