require('dotenv').config();
const http         = require('http');
const express      = require('express');
const cookieParser = require('cookie-parser');
const { Server }   = require('socket.io');
const path         = require('path');

const config      = require('./config');
const db          = require('./db');
const { router: agentRouter, buildSnapshot, emitOfferUpdate, emitQuotasUpdate, getParisClock } = require('./routes/agentRoutes');
const supervisorRouter = require('./routes/supervisorRoutes');
const systemRouter     = require('./routes/systemRoutes');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*' },
  connectionStateRecovery: {},
});

// ---------- Sessions actives agents (unicité stricte) ----------
// matricule -> { socketId, deviceId }
const activeSessions = new Map();
// socketId -> matricule
const socketToMatricule = new Map();

function releaseSessionByMatricule(agentMatricule) {
  const matricule = typeof agentMatricule === 'string' ? agentMatricule.trim() : '';
  if (!matricule) return { released: false, reason: 'INVALID_MATRICULE' };

  const session = activeSessions.get(matricule);
  if (!session || !session.socketId) return { released: false, reason: 'NOT_FOUND' };
  const socketId = session.socketId;

  let kicked = false;
  const targetSocket = io.sockets.sockets.get(socketId);
  if (targetSocket) {
    targetSocket.emit('force_logout', { reason: 'SUPERVISOR_ACTION' });
    kicked = true;
  }

  activeSessions.delete(matricule);
  if (socketToMatricule.get(socketId) === matricule) socketToMatricule.delete(socketId);
  io.to('supervisor').emit('session:update', { agent_matricule: matricule, isOnline: false });
  return { released: true, socketId, kicked };
}

function hasActiveSession(agentMatricule) {
  const matricule = typeof agentMatricule === 'string' ? agentMatricule.trim() : '';
  if (!matricule) return false;
  const session = activeSessions.get(matricule);
  if (!session || !session.socketId) return false;
  return io.sockets.sockets.has(session.socketId);
}

app.set('sessionRegistry', {
  releaseSessionByMatricule,
  hasActiveSession,
});

app.set('io', io);

// ---------- Middlewares Express ----------
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------- Routes API ----------
app.use('/api/agent',             agentRouter);
app.use('/api/supervisor',        supervisorRouter);
app.use('/api/supervisor/system', systemRouter);

app.get('/api/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

app.use('/api', (_req, res) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Endpoint inconnu' } });
});

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('[Unhandled Express Error]', err);
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Erreur serveur interne' } });
});

// ---------- Socket.io : gestion des rooms et connexions ----------
io.on('connection', socket => {
  const clientId = socket.id;
  console.log(`[socket] Connexion: ${clientId}`);

  (async () => {
    try {
      socket.emit('state:snapshot', await buildSnapshot());
      const mRow = await db.queryOne("SELECT value FROM app_settings WHERE key = 'maintenance_mode'");
      socket.emit('system:maintenance-mode', { active: mRow ? mRow.value === '1' : false });
    } catch (err) {
      console.error('[socket] initialisation', err);
    }
  })();

  socket.on('join:offer', ({ offerCode } = {}) => {
    if (typeof offerCode === 'string' && offerCode.trim()) {
      const roomName = `offer:${offerCode.trim().toUpperCase()}`;
      socket.join(roomName);
      console.log(`[socket] ${clientId} a rejoint ${roomName}`);
    }
  });

  socket.on('join:supervisor', () => {
    socket.join('supervisor');
    console.log(`[socket] ${clientId} a rejoint la room superviseur`);
  });

  socket.on('agent:identify', ({ agent_matricule, device_id } = {}) => {
    const matricule = typeof agent_matricule === 'string' ? agent_matricule.trim() : '';
    const deviceId = typeof device_id === 'string' ? device_id.trim() : '';
    if (!matricule) return;
    if (!deviceId) return;

    const existingSession = activeSessions.get(matricule);
    const existingSocketId = existingSession ? existingSession.socketId : null;
    const existingDeviceId = existingSession ? existingSession.deviceId : null;

    if (existingSocketId && existingSocketId !== clientId) {
      const sameDevice = existingDeviceId === deviceId;
      if (!sameDevice) {
        socket.emit('session:error', {
          code: 'SESSION_CONFLICT',
          message: "Session deja active sur un autre poste. Si c'est une erreur, contactez votre superviseur.",
        });
        return;
      }

      if (socketToMatricule.get(existingSocketId) === matricule) {
        socketToMatricule.delete(existingSocketId);
      }
    }

    const previousMatricule = socketToMatricule.get(clientId);
    const previousSession = previousMatricule ? activeSessions.get(previousMatricule) : null;
    if (previousMatricule && previousMatricule !== matricule && previousSession?.socketId === clientId) {
      activeSessions.delete(previousMatricule);
    }

    activeSessions.set(matricule, { socketId: clientId, deviceId });
    socketToMatricule.set(clientId, matricule);
    io.to('supervisor').emit('session:update', { agent_matricule: matricule, isOnline: true });
    socket.emit('session:identified', { agent_matricule: matricule });
  });

  socket.on('disconnect', () => {
    const matricule = socketToMatricule.get(clientId);
    const session = matricule ? activeSessions.get(matricule) : null;
    if (matricule && session?.socketId === clientId) {
      activeSessions.delete(matricule);
      io.to('supervisor').emit('session:update', { agent_matricule: matricule, isOnline: false });
    }
    socketToMatricule.delete(clientId);
    console.log(`[socket] Déconnexion: ${clientId}`);
  });
});

// ---------- Scheduler : auto-retour après MAX_PAUSE_MINUTES ----------
const SCHEDULER_INTERVAL_MS = 8000;

function nowIso() { return new Date().toISOString(); }

async function getMaxMs() {
  const row = await db.queryOne("SELECT value FROM app_settings WHERE key = 'max_pause_minutes'");
  const minutes = row ? parseInt(row.value, 10) : config.MAX_PAUSE_MINUTES;
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : config.MAX_PAUSE_MINUTES) * 60 * 1000;
}

let autoCloseRunning = false;
let lastQuotaSlotKey = null;

async function closeExpiredPauses() {
  const maxMs = await getMaxMs();
  const cutoff = new Date(Date.now() - maxMs).toISOString();

  const expired = await db.queryAll(
    'SELECT p.*, o.code AS offer_code, o.id AS offer_id_val, a.nom AS agent_nom, a.prenom AS agent_prenom ' +
    'FROM pauses p ' +
    'JOIN offers o ON o.id = p.offer_id ' +
    'JOIN agents a ON a.matricule = p.agent_matricule ' +
    "WHERE p.status = 'in_progress' AND p.start_time <= $1",
    [cutoff]
  );

  if (expired.length === 0) return;

  const now = nowIso();
  const currentMaxMinutes = Math.round(maxMs / 60000);

  await db.withTransaction(async (client) => {
    for (const p of expired) {
      await client.query(
        "UPDATE pauses SET status = 'ended', end_time = $1, end_reason = 'auto_15m', " +
        'duration_seconds = EXTRACT(EPOCH FROM ($1::timestamptz - start_time))::integer, ' +
        'max_minutes_at_end = $2, updated_at = $1 WHERE id = $3',
        [now, currentMaxMinutes, p.id]
      );
    }
  });

  for (const p of expired) {
    const duration = Math.round((new Date(now) - new Date(p.start_time)) / 1000);

    const stoppedPayload = {
      pauseId:         p.id,
      agent_matricule: p.agent_matricule,
      nom:             p.agent_nom,
      prenom:          p.agent_prenom,
      agentName:       `${p.agent_prenom} ${p.agent_nom}`,
      offerCode:       p.offer_code,
      endTime:         now,
      durationSeconds: duration,
      endReason:       'auto_15m',
    };

    io.to(`offer:${p.offer_code}`).emit('pause:stopped', stoppedPayload);
    io.emit('pause:stopped', stoppedPayload);

    await emitOfferUpdate(io, p.offer_code, p.offer_id_val);
    await emitQuotasUpdate(io);
  }
}

async function purgeHistory() {
  const row  = await db.queryOne("SELECT value FROM app_settings WHERE key = 'history_retention_days'");
  const days = row ? parseInt(row.value, 10) : config.HISTORY_RETENTION_DAYS;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const result = await db.query(
    "DELETE FROM pauses WHERE status = 'ended' AND end_time < $1",
    [cutoff]
  );

  if (result.rowCount > 0) console.log(`[purge] ${result.rowCount} pause(s) supprimée(s) (rétention: ${days} j)`);

  const staleOffers = await db.queryAll(
    `SELECT id FROM offers o
     WHERE o.purge_requested_at IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM pauses p WHERE p.offer_id = o.id)`
  );
  if (staleOffers.length === 0) return;

  let deleted = 0;
  await db.withTransaction(async (client) => {
    for (const offer of staleOffers) {
      const stillUsed = await client.query(
        'SELECT 1 FROM pauses WHERE offer_id = $1 LIMIT 1',
        [offer.id]
      );
      if (stillUsed.rowCount > 0) continue;
      await client.query('DELETE FROM quota_rules WHERE offer_id = $1', [offer.id]);
      await client.query('UPDATE wfm_activity_mappings SET offer_id = NULL WHERE offer_id = $1', [offer.id]);
      await client.query('DELETE FROM planning_slots WHERE offer_id = $1', [offer.id]);
      await client.query('DELETE FROM offers WHERE id = $1', [offer.id]);
      deleted += 1;
    }
  });
  if (deleted > 0) console.log(`[purge] ${deleted} offre(s) supprimée(s)`);
}

async function start() {
  await db.init();

  setInterval(() => {
    if (autoCloseRunning) return;
    autoCloseRunning = true;
    closeExpiredPauses()
      .catch(err => console.error('[scheduler] auto-close', err))
      .then(async () => {
        const clock = getParisClock();
        if (clock.minute % 15 !== 0) return;
        const key = `${clock.day}:${clock.slotMinutes}`;
        if (key === lastQuotaSlotKey) return;
        lastQuotaSlotKey = key;
        await emitQuotasUpdate(io);
      })
      .catch(err => console.error('[scheduler] quotas-slot', err))
      .finally(() => { autoCloseRunning = false; });
  }, SCHEDULER_INTERVAL_MS);

  setTimeout(() => {
    purgeHistory().catch(err => console.error('[scheduler] purge', err));
    setInterval(() => {
      purgeHistory().catch(err => console.error('[scheduler] purge', err));
    }, 24 * 60 * 60 * 1000);
  }, 10 * 60 * 1000);

  server.listen(config.PORT, () => {
    console.log(`[server] App pauses démarrée sur http://localhost:${config.PORT}`);
  });
}

start().catch(err => {
  console.error('[server] Échec de démarrage', err);
  process.exit(1);
});
