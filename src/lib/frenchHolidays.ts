'use strict';

type Ymd = { year: number; month: number; day: number };

/** Pâques grégorien (algorithme de Meeus/Jones/Butcher). month = 3 (mars) ou 4 (avril). */
function gregorianEaster(year: number): Ymd {
  const y = Number(year);
  const a = y % 19;
  const b = Math.floor(y / 100);
  const c = y % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { year: y, month, day };
}

function addUtcDays(year: number, month: number, day: number, delta: number): Ymd {
  const dt = new Date(Date.UTC(year, month - 1, day + delta));
  return {
    year: dt.getUTCFullYear(),
    month: dt.getUTCMonth() + 1,
    day: dt.getUTCDate(),
  };
}

function isoDate({ year, month, day }: Ymd): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * 11 jours fériés de France métropolitaine pour une année civile.
 * @returns dates YYYY-MM-DD
 */
function frenchHolidays(year: number): Set<string> {
  const y = Number(year);
  const easter = gregorianEaster(y);
  const dates = [
    isoDate({ year: y, month: 1, day: 1 }),
    isoDate(addUtcDays(easter.year, easter.month, easter.day, 1)),
    isoDate({ year: y, month: 5, day: 1 }),
    isoDate({ year: y, month: 5, day: 8 }),
    isoDate(addUtcDays(easter.year, easter.month, easter.day, 39)),
    isoDate(addUtcDays(easter.year, easter.month, easter.day, 50)),
    isoDate({ year: y, month: 7, day: 14 }),
    isoDate({ year: y, month: 8, day: 15 }),
    isoDate({ year: y, month: 11, day: 1 }),
    isoDate({ year: y, month: 11, day: 11 }),
    isoDate({ year: y, month: 12, day: 25 }),
  ];
  return new Set(dates);
}

function isFrenchHoliday(isoDay: string): boolean;
function isFrenchHoliday(year: number, month: number, day: number): boolean;
function isFrenchHoliday(year: number | string, month?: number, day?: number): boolean {
  if (typeof year === 'string' && month == null) {
    return frenchHolidays(Number(year.slice(0, 4))).has(year.slice(0, 10));
  }
  return frenchHolidays(year as number).has(isoDate({ year: year as number, month: month as number, day: day as number }));
}

module.exports = {
  gregorianEaster,
  frenchHolidays,
  isFrenchHoliday,
};
