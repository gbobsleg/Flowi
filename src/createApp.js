'use strict';

const http = require('http');
const express = require('express');
const cookieParser = require('cookie-parser');
const { Server } = require('socket.io');
const path = require('path');

const db = require('./db');
const { router: agentRouter, buildSnapshot } = require('./routes/agentRoutes');
const supervisorRouter = require('./routes/supervisorRoutes');
const systemRouter = require('./routes/systemRoutes');
const {
  loadAnonymizeAgentNames,
  redactSnapshot,
} = require('./lib/pauseIdentity');

function createApp() {
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, {
    cors: { origin: '*' },
    connectionStateRecovery: {},
  });

  const activeSessions = new Map();
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

  app.use(express.json());
  app.use(cookieParser());
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.use('/api/agent', agentRouter);
  app.use('/api/supervisor', supervisorRouter);
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

  io.on('connection', (socket) => {
    const clientId = socket.id;
    console.log(`[socket] Connexion: ${clientId}`);

    (async () => {
      try {
        const snapshot = await buildSnapshot();
        const anonymize = await loadAnonymizeAgentNames();
        socket.emit('state:snapshot', anonymize ? redactSnapshot(snapshot) : snapshot);
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
      buildSnapshot()
        .then((snapshot) => socket.emit('state:snapshot', snapshot))
        .catch((err) => console.error('[socket] snapshot superviseur', err));
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
      for (const room of [...socket.rooms]) {
        if (typeof room === 'string' && room.startsWith('agent:') && room !== `agent:${matricule}`) {
          socket.leave(room);
        }
      }
      socket.join(`agent:${matricule}`);
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

  return { app, server, io };
}

module.exports = { createApp };
