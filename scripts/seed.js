/**
 * Amorçage idempotent des données applicatives (paramètres, offres, quotas, agents de test).
 * Exécuter après le premier démarrage / migration (001_initial_schema.sql).
 */
require('dotenv').config();

const db = require('../src/db/sqlite');

const now = new Date().toISOString();

const APP_SETTINGS = [
  ['history_retention_days', '30'],
  ['supervisor_session_ttl_minutes', '480'],
  ['maintenance_mode', '0'],
  ['max_pause_minutes', '15'],
  ['github_owner', ''],
  ['github_repo', ''],
  ['github_token', ''],
  ['supervisor_pin', '1234'],
];

const OFFERS = [
  ['OFFRE_A', 'Offre A', 2],
  ['OFFRE_B', 'Offre B', 2],
  ['OFFRE_C', 'Offre C', 2],
  ['OFFRE_D', 'Offre D', 2],
];

const AGENTS = [
  ['MAT001', 'DUPONT', 'Alice', 1],
  ['MAT002', 'MARTIN', 'Bilal', 1],
  ['MAT003', 'NGUYEN', 'Chloe', 1],
  ['MAT100', 'LEROY', 'Amine', 1],
  ['MAT101', 'ROUX', 'Nora', 1],
  ['MAT102', 'GIRARD', 'Yanis', 1],
  ['MAT103', 'FAURE', 'Ines', 1],
  ['MAT104', 'MOREAU', 'Sofiane', 1],
  ['MAT105', 'SIMON', 'Lina', 1],
  ['MAT106', 'LAURENT', 'Mehdi', 1],
  ['MAT107', 'LEFEBVRE', 'Camille', 1],
  ['MAT108', 'MICHEL', 'Rayan', 1],
  ['MAT109', 'GARCIA', 'Sarah', 1],
  ['MAT110', 'DAVID', 'Ilyes', 1],
  ['MAT111', 'BERNARD', 'Maya', 1],
  ['MAT112', 'THOMAS', 'Noah', 1],
  ['MAT113', 'ROBERT', 'Jade', 1],
  ['MAT114', 'PETIT', 'Nassim', 1],
  ['MAT115', 'RICHARD', 'Lea', 1],
  ['MAT116', 'DURAND', 'Imran', 1],
  ['MAT117', 'DUBOIS', 'Aya', 1],
  ['MAT118', 'MOREL', 'Loris', 1],
  ['MAT119', 'FONTAINE', 'Nina', 1],
  ['MAT120', 'MERCIER', 'Anis', 1],
  ['MAT121', 'BONNET', 'Elsa', 1],
  ['MAT122', 'FRANCOIS', 'Mael', 1],
  ['MAT123', 'MULLER', 'Yasmine', 1],
  ['MAT124', 'MARTINEZ', 'Adam', 1],
  ['MAT125', 'LECLERC', 'Sana', 1],
  ['MAT126', 'LOPEZ', 'Ibrahim', 1],
  ['MAT127', 'CARON', 'Salome', 1],
  ['MAT128', 'GARNIER', 'Malo', 1],
  ['MAT129', 'BOYER', 'Sofia', 1],
];

function run() {
  const insertSetting = db.prepare(
    'INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)'
  );
  const insertOffer = db.prepare(
    `INSERT OR IGNORE INTO offers (code, label, default_quota, color, is_active, created_at)
     VALUES (?, ?, ?, NULL, 1, ?)`
  );
  const insertQuota = db.prepare(`
    INSERT OR IGNORE INTO quota_rules (offer_id, fixed_quota, present_count, allowed_percent, updated_at)
    SELECT o.id, o.default_quota, NULL, NULL, ?
    FROM offers o
    WHERE o.code = ?
  `);
  const insertAgent = db.prepare(
    'INSERT OR IGNORE INTO agents (matricule, nom, prenom, is_active) VALUES (?, ?, ?, ?)'
  );

  const tx = db.transaction(() => {
    for (const [k, v] of APP_SETTINGS) insertSetting.run(k, v);
    for (const [code, label, dq] of OFFERS) insertOffer.run(code, label, dq, now);
    for (const [code] of OFFERS) insertQuota.run(now, code);
    for (const row of AGENTS) insertAgent.run(...row);
  });

  tx();
  console.log('Seed terminé : app_settings, offers, quota_rules, agents (idempotent).');
}

run();
