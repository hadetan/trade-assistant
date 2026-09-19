// NSE's holiday-master endpoint is undocumented and unsupported: it can
// change shape, rate-limit, or vanish without notice. Every function here is
// best-effort by design -- fetchNseTradingHolidays never throws, it only ever
// returns the parsed list or null, so a caller can always fall back to the
// bundled static calendar as if the request had never been attempted.
const HOLIDAY_MASTER_URL = "https://www.nseindia.com/api/holiday-master?type=trading";

// NSE's basic bot-blocking rejects requests with no User-Agent outright; a
// realistic desktop Chrome UA plus an explicit JSON Accept header is enough
// to pass (verified directly against the live endpoint).
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

const MONTH_ABBREVIATIONS: Record<string, string> = {
  Jan: "01",
  Feb: "02",
  Mar: "03",
  Apr: "04",
  May: "05",
  Jun: "06",
  Jul: "07",
  Aug: "08",
  Sep: "09",
  Oct: "10",
  Nov: "11",
  Dec: "12",
};

function parseTradingDate(tradingDate: unknown): string | null {
  if (typeof tradingDate !== "string") return null;
  const match = /^(\d{2})-([A-Za-z]{3})-(\d{4})$/.exec(tradingDate);
  if (!match) return null;
  const [, day, monthAbbr, year] = match;
  const month = MONTH_ABBREVIATIONS[monthAbbr];
  if (!month) return null;

  const iso = `${year}-${month}-${day}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.getUTCFullYear() !== Number(year) ||
    parsed.getUTCMonth() + 1 !== Number(month) ||
    parsed.getUTCDate() !== Number(day)
  ) {
    return null;
  }
  return iso;
}

export function parseHolidayMasterResponse(json: unknown): string[] | null {
  if (typeof json !== "object" || json === null) return null;
  const cm = (json as Record<string, unknown>).CM;
  if (!Array.isArray(cm)) return null;

  const isoDates: string[] = [];
  for (const entry of cm) {
    if (typeof entry !== "object" || entry === null) return null;
    const iso = parseTradingDate((entry as Record<string, unknown>).tradingDate);
    // One bad entry invalidates the whole response -- a partial list would
    // silently under-report holidays, which is worse than falling back.
    if (iso === null) return null;
    isoDates.push(iso);
  }
  return isoDates;
}

export async function fetchNseTradingHolidays(fetchFn: typeof fetch = fetch): Promise<string[] | null> {
  try {
    const response = await fetchFn(HOLIDAY_MASTER_URL, {
      headers: {
        "User-Agent": BROWSER_USER_AGENT,
        Accept: "application/json",
      },
    });
    if (!response.ok) return null;
    const json = await response.json();
    return parseHolidayMasterResponse(json);
  } catch {
    return null;
  }
}
