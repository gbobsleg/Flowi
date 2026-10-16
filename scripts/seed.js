/**
 * Amorçage idempotent des données applicatives (paramètres, offres, quotas, agents de test).
 * Exécuter après les migrations. Idempotent.
 */
require('dotenv').config();

const db = require('../dist/db');

const now = new Date().toISOString();

const APP_SETTINGS = [
  ['history_retention_days', '30'],
  ['supervisor_session_ttl_minutes', '480'],
  ['maintenance_mode', '0'],
  ['max_pause_minutes', '15'],
  ['github_owner', 'gbobsleg'],
  ['github_repo', 'Flowi'],
  ['github_token', ''],
  ['supervisor_pin', '1234'],
  ['planning_import_weekdays', '[1,2,3,4,5]'],
  ['planning_skip_french_holidays', '1'],
  ['pause_windows', '[]'],
];

const OFFERS = [
  ['OFFRE_A', 'Offre A', 2],
  ['OFFRE_B', 'Offre B', 2],
  ['OFFRE_C', 'Offre C', 2],
  ['OFFRE_D', 'Offre D', 2],
];

const AGENTS = [
  ['MAT001', 'DUPONT', 'Alice', true],
  ['MAT002', 'MARTIN', 'Bilal', true],
  ['MAT003', 'NGUYEN', 'Chloe', true],
  ['MAT100', 'LEROY', 'Amine', true],
  ['MAT101', 'ROUX', 'Nora', true],
  ['MAT102', 'GIRARD', 'Yanis', true],
  ['MAT103', 'FAURE', 'Ines', true],
  ['MAT104', 'MOREAU', 'Sofiane', true],
  ['MAT105', 'SIMON', 'Lina', true],
  ['MAT106', 'LAURENT', 'Mehdi', true],
  ['MAT107', 'LEFEBVRE', 'Camille', true],
  ['MAT108', 'MICHEL', 'Rayan', true],
  ['MAT109', 'GARCIA', 'Sarah', true],
  ['MAT110', 'DAVID', 'Ilyes', true],
  ['MAT111', 'BERNARD', 'Maya', true],
  ['MAT112', 'THOMAS', 'Noah', true],
  ['MAT113', 'ROBERT', 'Jade', true],
  ['MAT114', 'PETIT', 'Nassim', true],
  ['MAT115', 'RICHARD', 'Lea', true],
  ['MAT116', 'DURAND', 'Imran', true],
  ['MAT117', 'DUBOIS', 'Aya', true],
  ['MAT118', 'MOREL', 'Loris', true],
  ['MAT119', 'FONTAINE', 'Nina', true],
  ['MAT120', 'MERCIER', 'Anis', true],
  ['MAT121', 'BONNET', 'Elsa', true],
  ['MAT122', 'FRANCOIS', 'Mael', true],
  ['MAT123', 'MULLER', 'Yasmine', true],
  ['MAT124', 'MARTINEZ', 'Adam', true],
  ['MAT125', 'LECLERC', 'Sana', true],
  ['MAT126', 'LOPEZ', 'Ibrahim', true],
  ['MAT127', 'CARON', 'Salome', true],
  ['MAT128', 'GARNIER', 'Malo', true],
  ['MAT129', 'BOYER', 'Sofia', true],
];

async function run() {
  try {
    await db.init();
    await db.withTransaction(async (client) => {
      for (const [k, v] of APP_SETTINGS) {
        await client.query(
          'INSERT IGNORE INTO app_settings (`key`, value) VALUES ($1, $2)',
          [k, v]
        );
      }

      for (const [code, label, dq] of OFFERS) {
        await client.query(
          `INSERT IGNORE INTO offers (code, label, default_quota, color, is_active, created_at)
           VALUES ($1, $2, $3, NULL, true, $4)`,
          [code, label, dq, now]
        );
      }

      for (const [code] of OFFERS) {
        await client.query(
          `INSERT IGNORE INTO quota_rules (offer_id, fixed_quota, present_count, allowed_percent, updated_at)
           SELECT o.id, NULL, NULL, 20, $1
           FROM offers o
           WHERE o.code = $2`,
          [now, code]
        );
      }

      await client.query(
        `UPDATE quota_rules qr
         INNER JOIN offers o ON qr.offer_id = o.id
         SET qr.fixed_quota = NULL,
             qr.allowed_percent = 20,
             qr.updated_at = $1
         WHERE qr.fixed_quota <=> o.default_quota
           AND qr.allowed_percent IS NULL`,
        [now]
      );

      for (const [matricule, nom, prenom, isActive] of AGENTS) {
        await client.query(
          `INSERT IGNORE INTO agents (matricule, nom, prenom, is_active)
           VALUES ($1, $2, $3, $4)`,
          [matricule, nom, prenom, isActive]
        );
      }
    });

    console.log('Seed terminé : app_settings, offers, quota_rules, agents (idempotent).');
  } finally {
    await db.close();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
