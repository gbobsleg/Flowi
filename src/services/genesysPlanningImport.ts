'use strict';

import type { PoolClient } from 'pg';

const iconv = require('iconv-lite');
const { parse } = require('csv-parse/sync');
import db = require('../db');
const { isFrenchHoliday } = require('../lib/frenchHolidays');

type QueryClient = Pick<PoolClient, 'query'>;

type GenesysCols = {
  date: number;
  employeeId: number;
  agent: number;
  state: number;
  start: number;
  end: number;
  paid: number;
};

type DetailRow = {
  day: string;
  employeeId: string;
  wfmLabel: string;
  startMin: number;
  endMin: number;
};

type ActivityRow = {
  day: string;
  wfmLabel: string;
  slotMinutes: number;
  headcount: number;
};

type MappingRow = {
  label: string;
  offer_id: unknown;
};

type OfferInput = {
  offerId?: unknown;
  id?: unknown;
  offerCode?: unknown;
  code?: unknown;
  label?: unknown;
  color?: unknown;
  isActive?: unknown;
  is_active?: unknown;
  defaultQuota?: unknown;
  default_quota?: unknown;
  allowedPercent?: unknown;
  allowed_percent?: unknown;
  fixedQuota?: unknown;
  fixed_quota?: unknown;
};

type OfferMeta = {
  offerId: unknown;
  offerCode: unknown;
  label: unknown;
  color: unknown;
  isActive: boolean;
  defaultQuota: number;
  allowedPercent: number | null;
  fixedQuota: number | null;
  slots: { slotMinutes: number; headcount: number; allowed: number }[];
};

class GenesysImportError extends Error {
  code: string;

  constructor(message: string, code = 'FORMAT') {
    super(message);
    this.name = 'GenesysImportError';
    this.code = code;
  }
}

function normalizeHeader(value: unknown): string {
  return String(value || '')
    .replace(/^\uFEFF/, '')
    .normalize('NFC')
    .trim()
    .toLowerCase();
}

function cell(row: unknown[], idx: number): string {
  if (idx == null || idx < 0 || !row || idx >= row.length) return '';
  return String(row[idx] == null ? '' : row[idx]).trim();
}

/** Retire les commentaires Genesys entre parenthèses et compacte les espaces. */
function canonicalWfmLabel(raw: unknown): string {
  return String(raw || '')
    .normalize('NFC')
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function indexColumns(headerRow: unknown[]): GenesysCols {
  const map: Record<string, number> = {};
  headerRow.forEach((h, i) => {
    map[normalizeHeader(h)] = i;
  });
  const find = (...aliases: string[]) => {
    for (const a of aliases) {
      if (map[a] != null) return map[a];
    }
    return -1;
  };
  return {
    date: find('date'),
    employeeId: find('id employé', 'id employe', 'id employee'),
    agent: find('agent'),
    state: find('état du planning', 'etat du planning'),
    start: find('heure de début', 'heure de debut'),
    end: find('heure de fin'),
    paid: find('heures payées', 'heures payees'),
  };
}

function parseGenesysDate(raw: unknown): string | null {
  const s = String(raw || '').trim();
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  let year = Number(m[3]);
  if (year < 100) year += 2000;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parseHmToMinutes(raw: unknown): number | null {
  const s = String(raw || '').trim();
  const m = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function isoWeekday(isoDay: string): number {
  const [y, m, d] = isoDay.split('-').map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return wd === 0 ? 7 : wd;
}

function intersectingSlots(startMin: number, endMin: number): number[] {
  const slots: number[] = [];
  if (!(startMin < endMin)) return slots;
  const first = Math.floor(startMin / 15) * 15;
  const last = Math.floor((endMin - 1) / 15) * 15;
  for (let t = first; t <= last && t < 1440; t += 15) {
    if (startMin < t + 15 && endMin > t) slots.push(t);
  }
  return slots;
}

function dayIncluded(isoDay: string, weekdays: Set<number>, skipHolidays: boolean): boolean {
  if (!weekdays.has(isoWeekday(isoDay))) return false;
  if (skipHolidays && isFrenchHoliday(isoDay)) return false;
  return true;
}

function parseGenesysCsv(buffer: Buffer): { details: DetailRow[]; daysInFile: string[] } {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new GenesysImportError('Fichier vide', 'FORMAT');
  }

  const text = iconv.decode(buffer, 'win1252');
  const rows: unknown[][] = parse(text, {
    relax_column_count: true,
    skip_empty_lines: true,
    relax_quotes: true,
  });

  const headerIdx = rows.findIndex((r) => r && normalizeHeader(r[0]) === 'site');
  if (headerIdx < 0) {
    throw new GenesysImportError('En-tête Genesys introuvable (ligne Site)', 'FORMAT');
  }

  const cols = indexColumns(rows[headerIdx]);
  if (cols.date < 0 || cols.state < 0 || cols.start < 0 || cols.end < 0) {
    throw new GenesysImportError('Colonnes Date / État / heures manquantes', 'FORMAT');
  }

  let lastDate: string | null = null;
  const details: DetailRow[] = [];
  const daysInFile = new Set<string>();

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.every((c) => !String(c || '').trim())) continue;

    const dated = parseGenesysDate(cell(row, cols.date));
    if (dated) {
      lastDate = dated;
      daysInFile.add(dated);
    }

    const startMin = parseHmToMinutes(cell(row, cols.start));
    const endMin = parseHmToMinutes(cell(row, cols.end));
    if (startMin == null || endMin == null) continue;

    const paid = cell(row, cols.paid);
    if (paid) continue;

    if (!lastDate) continue;

    const label = canonicalWfmLabel(cell(row, cols.state));
    if (!label) continue;

    const employeeId = cell(row, cols.employeeId) || cell(row, cols.agent);
    if (!employeeId) continue;

    daysInFile.add(lastDate);
    details.push({
      day: lastDate,
      employeeId,
      wfmLabel: label,
      startMin,
      endMin,
    });
  }

  return { details, daysInFile: [...daysInFile].sort() };
}

async function loadImportSettings(client: QueryClient): Promise<{ weekdays: Set<number>; skipHolidays: boolean }> {
  const result = await client.query(
    `SELECT key, value FROM app_settings
     WHERE key = ANY($1::text[])`,
    [['planning_import_weekdays', 'planning_skip_french_holidays']]
  );
  const map = Object.fromEntries(
    (result.rows as { key: string; value: string }[]).map((r) => [r.key, r.value])
  );

  let weekdays = [1, 2, 3, 4, 5];
  try {
    const parsed = JSON.parse(map.planning_import_weekdays || '[1,2,3,4,5]');
    if (Array.isArray(parsed) && parsed.length) weekdays = parsed.map(Number);
  } catch (_) {
    // défaut lun–ven
  }

  const skipHolidays = map.planning_skip_french_holidays !== '0';
  return { weekdays: new Set(weekdays), skipHolidays };
}

function aggregateDetails(details: DetailRow[], weekdays: Set<number>, skipHolidays: boolean): ActivityRow[] {
  const sets = new Map<string, Set<string>>();

  for (const row of details) {
    if (!dayIncluded(row.day, weekdays, skipHolidays)) continue;
    const slots = intersectingSlots(row.startMin, row.endMin);
    for (const slot of slots) {
      const key = `${row.day}\0${row.wfmLabel}\0${slot}`;
      let set = sets.get(key);
      if (!set) {
        set = new Set();
        sets.set(key, set);
      }
      set.add(row.employeeId);
    }
  }

  const rows: ActivityRow[] = [];
  for (const [key, ids] of sets) {
    const [day, wfmLabel, slotStr] = key.split('\0');
    rows.push({
      day,
      wfmLabel,
      slotMinutes: Number(slotStr),
      headcount: ids.size,
    });
  }
  return rows;
}

function computeUnmapped(activityRows: ActivityRow[], mappingRows: MappingRow[] | null | undefined): string[] {
  const mapped = new Map<string, unknown>();
  for (const row of mappingRows || []) {
    const key = canonicalWfmLabel(row.label);
    if (!key) continue;
    if (!mapped.has(key) || (mapped.get(key) == null && row.offer_id != null)) {
      mapped.set(key, row.offer_id);
    }
  }
  const labels = [...new Set(activityRows.map((r) => r.wfmLabel))].sort();
  return labels.filter((label) => !mapped.has(label));
}

function allowedFromHeadcountLocal(headcount: number, percent: number): number {
  const n = Number(headcount);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const p = Number(percent);
  if (!Number.isFinite(p) || p < 0) return 0;
  return Math.max(1, Math.floor((n * p) / 100));
}

function offerIdByCanon(mappingRows: MappingRow[] | null | undefined): Map<string, unknown> {
  const map = new Map<string, unknown>();
  for (const row of mappingRows || []) {
    if (row.offer_id == null) continue;
    const key = canonicalWfmLabel(row.label);
    if (!key) continue;
    const existing = map.get(key);
    if (existing == null || (row.offer_id as number) < (existing as number)) map.set(key, row.offer_id);
  }
  return map;
}

function normalizeOfferMeta(o: OfferInput): OfferMeta {
  const percentRaw = o.allowedPercent ?? o.allowed_percent;
  const fixedRaw = o.fixedQuota ?? o.fixed_quota;
  return {
    offerId: o.offerId ?? o.id,
    offerCode: o.offerCode ?? o.code,
    label: o.label,
    color: o.color ?? null,
    isActive: o.isActive === true || o.is_active === true,
    defaultQuota: Number(o.defaultQuota ?? o.default_quota ?? 0),
    allowedPercent: percentRaw == null || percentRaw === '' ? null : Number(percentRaw),
    fixedQuota: fixedRaw == null || fixedRaw === '' ? null : Number(fixedRaw),
    slots: [],
  };
}

/** Projection mémoire planning_slots : { [YYYY-MM-DD]: offers[] } même forme que GET /planning/slots. */
function slotsByDay(
  activityRows: ActivityRow[] | null | undefined,
  mappingRows: MappingRow[] | null | undefined,
  offers: OfferInput[] | null | undefined
): Record<string, OfferMeta[]> {
  const metas = (offers || []).map(normalizeOfferMeta);
  const labelToOfferId = offerIdByCanon(mappingRows);
  const days = [...new Set((activityRows || []).map((r) => r.day))].sort();
  const sums = new Map<string, Map<unknown, Map<number, number>>>();
  for (const row of activityRows || []) {
    const offerId = labelToOfferId.get(canonicalWfmLabel(row.wfmLabel));
    if (offerId == null) continue;
    if (!sums.has(row.day)) sums.set(row.day, new Map());
    const byOffer = sums.get(row.day)!;
    if (!byOffer.has(offerId)) byOffer.set(offerId, new Map());
    const bySlot = byOffer.get(offerId)!;
    bySlot.set(row.slotMinutes, (bySlot.get(row.slotMinutes) || 0) + Number(row.headcount));
  }

  const offersByDay: Record<string, OfferMeta[]> = {};
  for (const day of days) {
    const list = metas.map((o) => ({ ...o, slots: [] as OfferMeta['slots'] }));
    const byId = new Map(list.map((o) => [o.offerId, o]));
    const byOffer = sums.get(day);
    if (byOffer) {
      for (const [offerId, bySlot] of byOffer) {
        const offer = byId.get(offerId);
        if (!offer) continue;
        const minutes = [...bySlot.keys()].sort((a, b) => a - b);
        for (const slotMinutes of minutes) {
          const headcount = bySlot.get(slotMinutes)!;
          const allowed = offer.allowedPercent == null
            ? offer.defaultQuota
            : allowedFromHeadcountLocal(headcount, offer.allowedPercent);
          offer.slots.push({ slotMinutes, headcount, allowed });
        }
      }
    }
    offersByDay[day] = list;
  }
  return offersByDay;
}

async function analyseGenesysBuffer(buffer: Buffer, client: QueryClient) {
  const { details, daysInFile } = parseGenesysCsv(buffer);
  if (details.length === 0) {
    throw new GenesysImportError('Aucune ligne de détail (heures début/fin) dans le fichier', 'FORMAT');
  }
  const { weekdays, skipHolidays } = await loadImportSettings(client);
  const activityRows = aggregateDetails(details, weekdays, skipHolidays);
  const mappingRes = await client.query(
    'SELECT label, offer_id FROM wfm_activity_mappings'
  );
  return {
    details,
    daysInFile,
    activityRows,
    mappingRows: mappingRes.rows as MappingRow[],
    summary: {
      unmapped: computeUnmapped(activityRows, mappingRes.rows as MappingRow[]),
      detailRows: details.length,
      activityRows: activityRows.length,
      days: daysInFile,
    },
  };
}

async function insertActivities(client: QueryClient, rows: ActivityRow[]): Promise<void> {
  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const params: unknown[] = [];
    const placeholders = chunk.map((r, idx) => {
      const o = idx * 4;
      params.push(r.day, r.wfmLabel, r.slotMinutes, r.headcount);
      return `($${o + 1}::date, $${o + 2}, $${o + 3}, $${o + 4})`;
    });
    await client.query(
      `INSERT INTO planning_activities (day, wfm_label, slot_minutes, headcount)
       VALUES ${placeholders.join(', ')}`,
      params
    );
  }
}

async function importGenesysBuffer(buffer: Buffer) {
  return db.withTransaction(async (client) => {
    const analysed = await analyseGenesysBuffer(buffer, client);
    const { daysInFile, activityRows, summary } = analysed;

    if (daysInFile.length > 0) {
      await client.query(
        'DELETE FROM planning_activities WHERE day = ANY($1::date[])',
        [daysInFile]
      );
    }

    if (activityRows.length > 0) {
      await insertActivities(client, activityRows);
    }

    await db.rebuildPlanningSlots(client, daysInFile.length ? daysInFile : null);

    return summary;
  });
}

module.exports = {
  GenesysImportError,
  analyseGenesysBuffer,
  importGenesysBuffer,
  parseGenesysCsv,
  parseHmToMinutes,
  intersectingSlots,
  aggregateDetails,
  dayIncluded,
  canonicalWfmLabel,
  computeUnmapped,
  slotsByDay,
};
