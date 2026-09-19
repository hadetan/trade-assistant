import { getEffectiveHolidaysForYear, isYearCoveredByEffectiveCalendar } from "./nseHolidays";

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export const SESSION_OPEN_MINUTES = 9 * 60 + 15;
export const SESSION_CLOSE_MINUTES = 15 * 60 + 30;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

// Kite, NSE session boundaries, and the holiday calendar are all IST; wall-clock
// components are read off a UTC-shifted clone via the UTC getters so the host
// machine's own timezone can never change the answer.
function toIst(at: Date): Date {
  return new Date(at.getTime() + IST_OFFSET_MS);
}

function istDateKey(at: Date): string {
  const ist = toIst(at);
  return `${ist.getUTCFullYear()}-${pad(ist.getUTCMonth() + 1)}-${pad(ist.getUTCDate())}`;
}

function istSecondsOfDay(at: Date): number {
  const ist = toIst(at);
  return ist.getUTCHours() * 3600 + ist.getUTCMinutes() * 60 + ist.getUTCSeconds();
}

export function istYear(at: Date): number {
  return toIst(at).getUTCFullYear();
}

export function isHolidayCalendarCovered(year: number): boolean {
  return isYearCoveredByEffectiveCalendar(String(year));
}

export function isTradingDay(at: Date): boolean {
  const ist = toIst(at);
  const weekday = ist.getUTCDay();
  if (weekday === 0 || weekday === 6) return false;
  // An uncovered year degrades to weekends-only -- exactly what ingest.rs
  // already does -- rather than throwing inside a live readiness check.
  return !getEffectiveHolidaysForYear(String(ist.getUTCFullYear())).includes(istDateKey(at));
}

export function isWithinSessionHours(at: Date): boolean {
  if (!isTradingDay(at)) return false;
  const seconds = istSecondsOfDay(at);
  const openSeconds = SESSION_OPEN_MINUTES * 60;
  const closeSeconds = SESSION_CLOSE_MINUTES * 60;
  return seconds >= openSeconds && seconds <= closeSeconds;
}

function sessionOpenEpochSeconds(at: Date): number {
  const ist = toIst(at);
  const istMidnightUtcMs = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate());
  return (istMidnightUtcMs - IST_OFFSET_MS + SESSION_OPEN_MINUTES * 60 * 1000) / 1000;
}

export function nextSessionOpen(at: Date): number {
  // Inside or before today's session, "next open" is today's own open: the gate
  // only ever calls this to say when trading resumes, and a live session has
  // already resumed.
  let cursor = at;
  if (isTradingDay(cursor) && istSecondsOfDay(cursor) <= SESSION_CLOSE_MINUTES * 60) {
    return sessionOpenEpochSeconds(cursor);
  }
  do {
    cursor = new Date(cursor.getTime() + DAY_MS);
  } while (!isTradingDay(cursor));
  return sessionOpenEpochSeconds(cursor);
}
