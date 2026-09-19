import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fetchNseTradingHolidays } from "./nseHolidayFetcher";

function defaultCachePath(): string {
  return process.env.TRADE_ASSISTANT_HOLIDAY_CACHE ?? path.join(app.getPath("userData"), "nse-holiday-cache.json");
}

// Deliberate, narrow exception to "no mutable module state" (see CLAUDE.md):
// this map is written by loadCachedHolidayCalendar (once, at startup, before
// any refresh has run) and by refreshNseHolidayCalendar (whenever a live
// fetch succeeds) -- never from inside a pure calendar function.
// tradingCalendar.ts's isTradingDay/nextSessionOpen/isWithinSessionHours stay
// synchronous and I/O-free; they only ever read whatever
// getEffectiveHolidaysForYear currently returns. There is no hand-typed
// fallback any more: an uncovered year (nothing cached, nothing fetched yet)
// simply returns no holidays for that year, same as before a refresh ever ran.
let holidayOverridesByYear: Record<string, readonly string[]> = {};

export function getEffectiveHolidaysForYear(year: string): readonly string[] {
  return holidayOverridesByYear[year] ?? [];
}

export function isYearCoveredByEffectiveCalendar(year: string): boolean {
  return Object.prototype.hasOwnProperty.call(holidayOverridesByYear, year);
}

function isRecordOfStringArrays(value: unknown): value is Record<string, string[]> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every(
    (entry) => Array.isArray(entry) && entry.every((item) => typeof item === "string"),
  );
}

// Must be called exactly once, synchronously, very early at startup
// (bootstrap.ts) -- strictly BEFORE refreshNseHolidayCalendar has had any
// chance to run. It unconditionally assigns holidayOverridesByYear from
// whatever it reads, so calling it after a successful refresh would discard
// that refresh's (more current) in-memory data in favor of a possibly-older
// cached snapshot.
//
// Best-effort, same posture as the live fetch itself: a missing file,
// unreadable file, malformed JSON, or JSON that doesn't look like
// Record<string, string[]> all silently leave the override map untouched
// rather than throwing.
export function loadCachedHolidayCalendar(cachePath: string = defaultCachePath()): void {
  try {
    const raw = fs.readFileSync(cachePath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (!isRecordOfStringArrays(parsed)) return;
    holidayOverridesByYear = parsed;
  } catch {
    // Missing file, unreadable file, or malformed JSON: leave whatever was
    // already there (nothing, this early in startup) untouched.
  }
}

// Best-effort only: on any fetch/parse failure this leaves the override map
// completely untouched (whatever was there before, including nothing) and
// reports "fallback", so callers can log the outcome without ever needing to
// treat it as an error. On success, the complete resulting override map --
// not just the newly-fetched years -- is persisted to cachePath so a later
// process can call loadCachedHolidayCalendar and get everything known so
// far, not only the last fetch's years. That persistence is itself
// best-effort: a write failure (disk full, missing directory, permissions)
// never changes the "refreshed" outcome or throws, since the in-memory
// override already updated successfully, which is what matters for the
// current process.
export async function refreshNseHolidayCalendar(
  fetchFn?: typeof fetch,
  cachePath: string = defaultCachePath(),
): Promise<"refreshed" | "fallback"> {
  const holidays = await fetchNseTradingHolidays(fetchFn);
  if (holidays === null) return "fallback";

  const groupedByYear: Record<string, string[]> = {};
  for (const iso of holidays) {
    const year = iso.slice(0, 4);
    (groupedByYear[year] ??= []).push(iso);
  }
  holidayOverridesByYear = { ...holidayOverridesByYear, ...groupedByYear };

  try {
    fs.writeFileSync(cachePath, JSON.stringify(holidayOverridesByYear));
  } catch {
    // See doc comment above: a failed cache write only costs the NEXT run's
    // instant startup data, never this one's.
  }

  return "refreshed";
}
