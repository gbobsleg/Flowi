'use strict';

import type { PoolClient } from 'pg';

function canonicalWfmLabelSql(column: string): string {
  return `TRIM(BOTH FROM REGEXP_REPLACE(REGEXP_REPLACE(${column}, '\\s*\\([^)]*\\)', ' ', 'g'), '\\s+', ' ', 'g'))`;
}

async function rebuildPlanningSlots(client: PoolClient, dates: string[] | null = null): Promise<void> {
  if (!client || typeof client.query !== 'function') {
    throw new Error('rebuildPlanningSlots : client pg requis');
  }

  const scoped = Array.isArray(dates) && dates.length > 0;

  if (scoped) {
    await client.query('DELETE FROM planning_slots WHERE day = ANY($1::date[])', [dates]);
  } else {
    await client.query('DELETE FROM planning_slots');
  }

  const whereDay = scoped ? 'AND a.day = ANY($1::date[])' : '';
  const params = scoped ? [dates] : [];

  const activityCanon = canonicalWfmLabelSql('a.wfm_label');
  const mappingCanon = canonicalWfmLabelSql('m.label');

  await client.query(
    `INSERT INTO planning_slots (day, offer_id, slot_minutes, headcount)
     SELECT a.day, map.offer_id, a.slot_minutes, SUM(a.headcount)::integer
     FROM planning_activities a
     INNER JOIN (
       SELECT DISTINCT ON (canon) offer_id, canon
       FROM (
         SELECT offer_id, ${mappingCanon} AS canon
         FROM wfm_activity_mappings m
         WHERE m.offer_id IS NOT NULL
       ) mapped
       ORDER BY canon, offer_id
     ) map ON map.canon = ${activityCanon}
     WHERE 1 = 1
       ${whereDay}
     GROUP BY a.day, map.offer_id, a.slot_minutes`,
    params
  );
}

module.exports = { rebuildPlanningSlots };
