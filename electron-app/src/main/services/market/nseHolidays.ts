import { fetchNseTradingHolidays } from "./nseHolidayFetcher";

// NSE trading holidays, keyed by four-digit year, values as IST calendar dates.
//
// This file goes stale every year and code cannot self-correct it on its own:
// when a new year's circular is published, append its key here and bump
// NSE_HOLIDAY_CALENDAR_LAST_VERIFIED. A year with no key degrades to
// weekends-only (tradingCalendar.isTradingDay), never to a crash.
//
// refreshNseHolidayCalendar (below) can additionally patch individual years
// at runtime from NSE's own holiday-master feed, but this static map remains
// the permanent, always-available fallback.
export const NSE_HOLIDAY_CALENDAR_SOURCE =
  "https://www.nseindia.com/resources/exchange-communication-holidays";

export const NSE_HOLIDAY_CALENDAR_LAST_VERIFIED = "2026-09-17";

export const NSE_HOLIDAY_CALENDAR: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "2026": Object.freeze([
    "2026-01-26", // Republic Day
    "2026-03-03", // Holi
    "2026-03-21", // Id-ul-Fitr (Ramzan Id)
    "2026-04-01", // Mahavir Jayanti
    "2026-04-03", // Good Friday
    "2026-04-14", // Dr. Ambedkar Jayanti
    "2026-05-01", // Maharashtra Day
    "2026-05-28", // Bakri Id
    "2026-06-26", // Muharram
    "2026-08-15", // Independence Day
    "2026-08-28", // Ganesh Chaturthi
    "2026-10-02", // Mahatma Gandhi Jayanti
    "2026-10-21", // Dussehra
    "2026-11-09", // Diwali Balipratipada
    "2026-11-24", // Guru Nanak Jayanti
    "2026-12-25", // Christmas
  ] as const),
});

// Deliberate, narrow exception to "no mutable module state" (see CLAUDE.md):
// this map is written exactly once per process, by refreshNseHolidayCalendar
// below, itself called exactly once at app startup (bootstrap.ts) -- never
// from inside a pure calendar function. tradingCalendar.ts's isTradingDay/
// nextSessionOpen/isWithinSessionHours stay synchronous and I/O-free; they
// only ever read whatever getEffectiveHolidaysForYear currently returns,
// which is either this override (if a refresh has succeeded for that year)
// or the static NSE_HOLIDAY_CALENDAR above.
let holidayOverridesByYear: Record<string, readonly string[]> = {};

export function getEffectiveHolidaysForYear(year: string): readonly string[] {
  return holidayOverridesByYear[year] ?? NSE_HOLIDAY_CALENDAR[year] ?? [];
}

export function isYearCoveredByEffectiveCalendar(year: string): boolean {
  return (
    Object.prototype.hasOwnProperty.call(holidayOverridesByYear, year) ||
    Object.prototype.hasOwnProperty.call(NSE_HOLIDAY_CALENDAR, year)
  );
}

// Best-effort only: on any fetch/parse failure this leaves the override map
// completely untouched (whatever was there before, including nothing) and
// reports "fallback", so callers can log the outcome without ever needing to
// treat it as an error.
export async function refreshNseHolidayCalendar(fetchFn?: typeof fetch): Promise<"refreshed" | "fallback"> {
  const holidays = await fetchNseTradingHolidays(fetchFn);
  if (holidays === null) return "fallback";

  const groupedByYear: Record<string, string[]> = {};
  for (const iso of holidays) {
    const year = iso.slice(0, 4);
    (groupedByYear[year] ??= []).push(iso);
  }
  holidayOverridesByYear = { ...holidayOverridesByYear, ...groupedByYear };
  return "refreshed";
}
