// NSE trading holidays, keyed by four-digit year, values as IST calendar dates.
//
// This file goes stale every year and code cannot self-correct it: when a new
// year's circular is published, append its key here and bump
// NSE_HOLIDAY_CALENDAR_LAST_VERIFIED. A year with no key degrades to
// weekends-only (tradingCalendar.isTradingDay), never to a crash.
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
