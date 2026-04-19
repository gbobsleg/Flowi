require('dotenv').config();
const http         = require('http');
const express      = require('express');
const cookieParser = require('cookie-parser');
const { Server }   = require('socket.io');
const path         = require('path');

const config      = require('./config');
const db          = require('./db/sqlite');
const { router: agentRouter, effectiveQuota, countActivePauses, buildSnapshot, emitOfferUpdate, emitQuotasUpdate } = require('./routes/agentRoutes');
const supervisorRouter = require('./routes/supervisorRoutes');
const systemRouter     = require('./routes/systemRoutes');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*' },
  // Désactiver l'événement 'connect_error' côté serveur pour les clients non authentifiés
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

// io accessible dans les routes via req.app.get('io')
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

// Gestionnaire 404 pour les routes API inconnues
app.use('/api', (_req, res) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Endpoint inconnu' } });
});

// Gestionnaire d'erreurs Express global (capture les erreurs non interceptées)
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('[Unhandled Express Error]', err);
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Erreur serveur interne' } });
});

// ---------- Socket.io : gestion des rooms et connexions ----------
io.on('connection', socket => {
  const clientId = socket.id;
  console.log(`[socket] Connexion: ${clientId}`);

  // Envoyer le snapshot complet à ce client uniquement
  socket.emit('state:snapshot', buildSnapshot());

  // Envoyer l'état maintenance au nouveau client
  const mRow = db.prepare("SELECT value FROM app_settings WHERE key = 'maintenance_mode'").get();
  socket.emit('system:maintenance-mode', { active: mRow ? mRow.value === '1' : false });

  // Rejoindre la room de l'offre demandée
  // Le client envoie { offerCode } pour s'abonner aux événements de son offre
  socket.on('join:offer', ({ offerCode } = {}) => {
    if (typeof offerCode === 'string' && offerCode.trim()) {
      const roomName = `offer:${offerCode.trim().toUpperCase()}`;
      socket.join(roomName);
      console.log(`[socket] ${clientId} a rejoint ${roomName}`);
    }
  });

  // Rejoindre la room superviseur (lecture seule côté Socket)
  socket.on('join:supervisor', () => {
    socket.join('supervisor');
    console.log(`[socket] ${clientId} a rejoint la room superviseur`);
  });

  // Identifier l'agent pour unicité de session
  socket.on('agent:identify', ({ agent_matricule, device_id } = {}) => {
    const matricule = typeof agent_matricule === 'string' ? agent_matricule.trim() : '';
    const deviceId = typeof device_id === 'string' ? device_id.trim() : '';
    if (!matricule) return;
    if (!deviceId) return;

    const existingSession = activeSessions.get(matricule);
    const existingSocketId = existingSession ? existingSession.socketId : null;
    const existingDeviceId = existingSession ? existingSession.deviceId : null;
    const existingSocketIsPresent = !!(existingSocketId && io.sockets.sockets.has(existingSocketId));
    console.log('[session] identify attempt', {
      matricule,
      clientId,
      deviceId,
      existingSocketId: existingSocketId || null,
      existingDeviceId: existingDeviceId || null,
      hasExistingSocket: existingSocketIsPresent,
      activeSessions: Array.from(activeSessions.entries()),
    });

    if (existingSocketId && existingSocketId !== clientId) {
      const sameDevice = existingDeviceId === deviceId;
      if (!sameDevice) {
        socket.emit('session:error', {
          code: 'SESSION_CONFLICT',
          message: "Session deja active sur un autre poste. Si c'est une erreur, contactez votre superviseur.",
        });
        return;
      }

      // Même device_id (ex: F5) : écrasement silencieux, sans expulsion.
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

function getMaxMs() {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = 'max_pause_minutes'").get();
  const minutes = row ? parseInt(row.value, 10) : config.MAX_PAUSE_MINUTES;
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : config.MAX_PAUSE_MINUTES) * 60 * 1000;
}

setInterval(() => {
  const cutoff = new Date(Date.now() - getMaxMs()).toISOString();

  const expired = db.prepare(
    'SELECT p.*, o.code AS offer_code, o.id AS offer_id_val, a.nom AS agent_nom, a.prenom AS agent_prenom ' +
    'FROM pauses p ' +
    'JOIN offers o ON o.id = p.offer_id ' +
    'JOIN agents a ON a.matricule = p.agent_matricule ' +
    "WHERE p.status = 'in_progress' AND p.start_time <= ?"
  ).all(cutoff);

  if (expired.length === 0) return;

  const now = nowIso();
  const currentMaxMinutes = Math.round(getMaxMs() / 60000);

  const closeStmt = db.prepare(
    "UPDATE pauses SET status = 'ended', end_time = ?, end_reason = 'auto_15m', " +
    'duration_seconds = CAST((julianday(?) - julianday(start_time)) * 86400 AS INTEGER), ' +
    'max_minutes_at_end = ?, updated_at = ? WHERE id = ?'
  );

  db.transaction(pauses => {
    for (const p of pauses) closeStmt.run(now, now, currentMaxMinutes, now, p.id);
  })(expired);

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

    // Cibler la room de l'offre + broadcast global
    io.to(`offer:${p.offer_code}`).emit('pause:stopped', stoppedPayload);
    io.emit('pause:stopped', stoppedPayload);

    emitOfferUpdate(io, p.offer_code, p.offer_id_val);
    emitQuotasUpdate(io);
  }
}, SCHEDULER_INTERVAL_MS);

// ---------- Scheduler : purge historique ----------
function purgeHistory() {
  const row  = db.prepare("SELECT value FROM app_settings WHERE key = 'history_retention_days'").get();
  const days = row ? parseInt(row.value, 10) : config.HISTORY_RETENTION_DAYS;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const { changes } = db.prepare(
    "DELETE FROM pauses WHERE status = 'ended' AND end_time < ?"
  ).run(cutoff);

  if (changes > 0) console.log(`[purge] ${changes} pause(s) supprimée(s) (rétention: ${days} j)`);
}

setTimeout(() => {
  purgeHistory();
  setInterval(purgeHistory, 24 * 60 * 60 * 1000);
}, 10 * 60 * 1000);

// ---------- Démarrage ----------
server.listen(config.PORT, () => {
  console.log(`[server] App pauses démarrée sur http://localhost:${config.PORT}`);
});
