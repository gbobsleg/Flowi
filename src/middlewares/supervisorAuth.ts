'use strict';

import type { NextFunction, Request, Response } from 'express';

const config = require('../config');
import db = require('../db');

const sessions = new Map<string, number>();

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

function createSession(): string {
  const { randomUUID } = require('crypto');
  const token = randomUUID();
  const expires = Date.now() + SESSION_TTL_MS;
  sessions.set(token, expires);
  return token;
}

async function getEffectiveSupervisorPin(): Promise<string> {
  const row = await db.queryOne<{ value: string }>("SELECT value FROM app_settings WHERE key = 'supervisor_pin'");
  if (row && typeof row.value === 'string') {
    const v = row.value.trim();
    if (v !== '') return v;
  }
  return config.SUPERVISOR_PIN;
}

async function validatePin(pin: unknown): Promise<boolean> {
  return pin === await getEffectiveSupervisorPin();
}

function validateToken(token: unknown): boolean {
  if (typeof token !== 'string' || !token) return false;
  const expires = sessions.get(token);
  if (!expires) return false;
  if (Date.now() > expires) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function revokeToken(token: unknown): void {
  if (typeof token === 'string') sessions.delete(token);
}

function requireSupervisor(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const bearer = typeof header === 'string' ? header.replace('Bearer ', '') : '';
  const token = (req.cookies && req.cookies.sv_token) || bearer;

  if (!validateToken(token)) {
    return res.status(401).json({ error: 'Non autorisé' });
  }
  next();
}

module.exports = { createSession, validatePin, validateToken, revokeToken, requireSupervisor };
