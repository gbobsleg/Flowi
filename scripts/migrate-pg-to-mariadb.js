/**
 * Copie unique des données PostgreSQL vers MariaDB (passage à MariaDB, PR #10).
 *
 * - Crée le schéma MariaDB via les migrations de l'application (db.init()).
 * - Refuse de tourner si MariaDB contient déjà des pauses (base déjà en service).
 * - Vide les tables MariaDB (seed éventuel) puis recopie chaque table, ids compris.
 * - Tout se fait dans une seule transaction ; les comptes de lignes sont vérifiés avant validation.
 *
 * Usage (dans l'image flowi, pg installé à la volée) :
 *   PG_URL=postgres://flowi:flowi@flowi-postgres:5432/flowi node scripts/migrate-pg-to-mariadb.js
 * DATABASE_URL (MariaDB) est fourni par docker-compose.yml.
 */
require('dotenv').config();

const { Client, types } = require('pg');
const mysql = require('mysql2/promise');
const db = require('../dist/db');

// DATE en texte brut : sans cela pg crée un Date à minuit heure locale et le jour peut reculer.
types.setTypeParser(1082, (v) => v);

// Ordre compatible avec les clés étrangères (parents d'abord).
const TABLES = [
  'offers',
  'agents',
  'app_settings',
  'quota_rules',
  'pauses',
  'planning_activities',
  'wfm_activity_mappings',
  'planning_slots',
];
const IGNORED = new Set(['schema_migrations']);
const BATCH = 500;

async function main() {
  const pgUrl = process.env.PG_URL;
  if (!pgUrl) throw new Error('PG_URL manquant (ex. postgres://flowi:flowi@flowi-postgres:5432/flowi)');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL (MariaDB) manquant');

  console.log('1/5 Schéma MariaDB (migrations)…');
  await db.init();
  await db.close();

  const pg = new Client({ connectionString: pgUrl });
  await pg.connect();
  const my = await mysql.createConnection({ uri: process.env.DATABASE_URL, timezone: 'Z', charset: 'utf8mb4' });
  await my.query("SET time_zone = '+00:00'");

  try {
    console.log('2/5 Contrôles…');
    const { rows: pgTables } = await pg.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'"
    );
    const unknown = pgTables.map((r) => r.table_name).filter((t) => !TABLES.includes(t) && !IGNORED.has(t));
    if (unknown.length) throw new Error(`Tables Postgres non prises en charge : ${unknown.join(', ')}`);

    const { rows: pgMig } = await pg.query('SELECT filename FROM schema_migrations ORDER BY filename');
    const [myMig] = await my.query('SELECT filename FROM schema_migrations ORDER BY filename');
    const missing = myMig.map((r) => r.filename).filter((f) => !pgMig.some((p) => p.filename === f));
    if (missing.length) throw new Error(`Postgres n'a pas toutes les migrations : ${missing.join(', ')}`);

    const [[{ n: myPauses }]] = await my.query('SELECT COUNT(*) AS n FROM pauses');
    if (Number(myPauses) > 0) {
      throw new Error(`MariaDB contient déjà ${myPauses} pause(s) : copie annulée pour ne rien écraser`);
    }

    console.log('3/5 Copie…');
    await my.beginTransaction();
    await my.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of [...TABLES].reverse()) await my.query(`DELETE FROM \`${t}\``);

    const expected = {};
    for (const t of TABLES) {
      const [cols] = await my.query(
        'SELECT column_name AS c FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? ORDER BY ordinal_position',
        [t]
      );
      const names = cols.map((r) => r.c);
      const { rows } = await pg.query(`SELECT ${names.map((n) => `"${n}"`).join(', ')} FROM "${t}"`);
      expected[t] = rows.length;
      for (let i = 0; i < rows.length; i += BATCH) {
        const chunk = rows.slice(i, i + BATCH).map((r) => names.map((n) => r[n]));
        await my.query(`INSERT INTO \`${t}\` (${names.map((n) => `\`${n}\``).join(', ')}) VALUES ?`, [chunk]);
      }
      console.log(`   ${t.padEnd(22)} ${rows.length} ligne(s)`);
    }
    await my.query('SET FOREIGN_KEY_CHECKS = 1');

    console.log('4/5 Vérification des comptes…');
    for (const t of TABLES) {
      const [[{ n }]] = await my.query(`SELECT COUNT(*) AS n FROM \`${t}\``);
      if (Number(n) !== expected[t]) throw new Error(`${t} : ${n} ligne(s) dans MariaDB, ${expected[t]} attendue(s)`);
    }

    await my.commit();
    console.log('5/5 Terminé : données copiées et validées.');
  } catch (err) {
    await my.rollback().catch(() => {});
    throw err;
  } finally {
    await pg.end();
    await my.end();
  }
}

main().catch((err) => {
  console.error('ÉCHEC :', err.message);
  process.exit(1);
});
