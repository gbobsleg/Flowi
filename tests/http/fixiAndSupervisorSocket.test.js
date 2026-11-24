'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const httpEnabled = process.env.NODE_ENV === 'test' && !!process.env.DATABASE_URL;
if (httpEnabled) {
  require('../helpers/guard').assertSafeTestDatabase();
}

/** Attend que la room `supervisor` contienne `expected` sockets (le join est traité côté serveur). */
async function waitSupervisorRoomSize(io, expected, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  let size = -1;
  while (Date.now() < deadline) {
    size = (await io.in('supervisor').fetchSockets()).length;
    if (size === expected) return size;
    await new Promise((r) => setTimeout(r, 50));
  }
  return size;
}

describe('HTTP fixi-loader et socket superviseur', { skip: !httpEnabled }, () => {
  let helpers;
  let ctx;
  let token;

  before(async () => {
    helpers = require('../helpers/app');
    ctx = await helpers.startTestApp();
  });

  after(async () => {
    if (helpers && ctx) await helpers.stopTestApp(ctx);
  });

  beforeEach(async () => {
    await helpers.resetDb();
    token = await helpers.loginSupervisor(ctx.baseUrl);
  });

  it('GET /fixi-loader.js renvoie un script JavaScript non mis en cache', async () => {
    const res = await fetch(`${ctx.baseUrl}/fixi-loader.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /^application\/javascript/);
    assert.equal(res.headers.get('cache-control'), 'no-cache');
    const body = await res.text();
    assert.match(body, /window\.fixiSetUser/);
  });

  it('join:supervisor sans session : refusé, hors de la room superviseur', async () => {
    const socket = await helpers.connectSupervisorSocket(ctx.baseUrl);
    try {
      await helpers.waitForEvent(socket, 'supervisor:unauthorized');
      assert.equal(await waitSupervisorRoomSize(ctx.io, 0, 300), 0);
    } finally {
      socket.close();
    }
  });

  it('join:supervisor avec un token invalide : refusé', async () => {
    const socket = await helpers.connectSupervisorSocket(ctx.baseUrl, 'faux-token');
    try {
      await helpers.waitForEvent(socket, 'supervisor:unauthorized');
      assert.equal(await waitSupervisorRoomSize(ctx.io, 0, 300), 0);
    } finally {
      socket.close();
    }
  });

  it('join:supervisor avec le cookie sv_token : rejoint la room superviseur', async () => {
    const socket = await helpers.connectSupervisorSocket(ctx.baseUrl, token);
    try {
      assert.equal(await waitSupervisorRoomSize(ctx.io, 1), 1);
    } finally {
      socket.close();
    }
  });
});
