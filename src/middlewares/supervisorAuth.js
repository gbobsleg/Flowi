const config = require('../config');
const db = require('../db');

// Token de session en mémoire (Map uuid -> expiry timestamp)
const sessions = new Map();

const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 heures par défaut

function createSession() {
  const { randomUUID } = require('crypto');
  const token   = randomUUID();
  const expires = Date.now() + SESSION_TTL_MS;
  sessions.set(token, expires);
  return token;
}

/** PIN stocké en base si présent et non vide ; sinon repli sur SUPERVISOR_PIN (.env). */
async function getEffectiveSupervisorPin() {
  const row = await db.queryOne("SELECT value FROM app_settings WHERE key = 'supervisor_pin'");
  if (row && typeof row.value === 'string') {
    const v = row.value.trim();
    if (v !== '') return v;
  }
  return config.SUPERVISOR_PIN;
}

async function validatePin(pin) {
  return pin === await getEffectiveSupervisorPin();
}

function validateToken(token) {
  if (!token) return false;
  const expires = sessions.get(token);
  if (!expires) return false;
  if (Date.now() > expires) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function revokeToken(token) {
  sessions.delete(token);
}

// Middleware Express: attend le token dans le cookie "sv_token" ou header Authorization
function requireSupervisor(req, res, next) {
  const token =
    (req.cookies && req.cookies.sv_token) ||
    (req.headers.authorization && req.headers.authorization.replace('Bearer ', ''));

  if (!validateToken(token)) {
    return res.status(401).json({ error: 'Non autorisé' });
  }
  next();
}

module.exports = { createSession, validatePin, validateToken, revokeToken, requireSupervisor };
