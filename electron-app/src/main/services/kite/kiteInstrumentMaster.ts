import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

export interface KiteInstrumentRow {
  instrument_token: string;
  tradingsymbol: string;
  exchange: string;
  segment: string;
  name: string;
}

export interface KiteInstrumentMasterDeps {
  apiKey: string;
  accessToken: string;
  cacheDir: string;
  fetchFn?: typeof fetch;
  now?: () => Date;
}

interface CacheFile {
  fetchedOnIstDate: string;
  rows: KiteInstrumentRow[];
}

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const MAX_RESULTS = 25;

function istDateString(at: Date): string {
  const ist = new Date(at.getTime() + IST_OFFSET_MS);
  return ist.toISOString().slice(0, 10);
}

// Kite's instrument dump is RFC4180-ish CSV: a double-quoted field may
// contain a literal comma (some company names do), so a naive split(",")
// would misalign columns on those rows.
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      fields.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields;
}

export function parseInstrumentCsv(csv: string): KiteInstrumentRow[] {
  const lines = csv.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length <= 1) return [];
  const header = parseCsvLine(lines[0]);
  const col = (name: string): number => header.indexOf(name);
  const tokenCol = col("instrument_token");
  const symbolCol = col("tradingsymbol");
  const nameCol = col("name");
  const segmentCol = col("segment");
  const exchangeCol = col("exchange");
  return lines.slice(1).map((line) => {
    const fields = parseCsvLine(line);
    return {
      instrument_token: fields[tokenCol] ?? "",
      tradingsymbol: fields[symbolCol] ?? "",
      name: fields[nameCol] ?? "",
      segment: fields[segmentCol] ?? "",
      exchange: fields[exchangeCol] ?? "",
    };
  });
}

// Ranks an already-substring-filtered row so an exact tradingsymbol match
// (e.g. "NSE:INFY") sorts ahead of the far more numerous F&O contract rows
// that also substring-match a liquid underlying's name (e.g. "INFY26SEPFUT"),
// which would otherwise crowd the exact match out of the MAX_RESULTS cap.
function matchRank(row: KiteInstrumentRow, needle: string): number {
  const symbol = row.tradingsymbol.toLowerCase();
  if (symbol === needle) return 0;
  if (symbol.startsWith(needle)) return 1;
  return 2;
}

export class KiteInstrumentMaster {
  private readonly deps: KiteInstrumentMasterDeps;
  private cache: CacheFile | null = null;
  private refreshPromise: Promise<void> | null = null;

  constructor(deps: KiteInstrumentMasterDeps) {
    this.deps = deps;
  }

  private cachePath(): string {
    return path.join(this.deps.cacheDir, "kite-instruments.json");
  }

  // Private: search() is the only public entry point, so a caller can never
  // search a stale/never-downloaded cache by forgetting to call this first.
  private async ensureFresh(): Promise<void> {
    const now = this.deps.now?.() ?? new Date();
    const today = istDateString(now);
    if (this.cache?.fetchedOnIstDate === today) return;

    if (!this.cache) {
      try {
        const raw = await readFile(this.cachePath(), "utf8");
        const parsed = JSON.parse(raw) as CacheFile;
        if (parsed.fetchedOnIstDate === today) {
          this.cache = parsed;
          return;
        }
      } catch {
        // No cache file yet, or it's corrupt/unreadable -- fall through to a
        // fresh download either way, same as a first-ever launch.
      }
    }

    if (this.refreshPromise) return this.refreshPromise;

    this.refreshPromise = this.downloadAndCache(today).finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  private async downloadAndCache(today: string): Promise<void> {
    const fetchFn = this.deps.fetchFn ?? fetch;
    const response = await fetchFn("https://api.kite.trade/instruments", {
      headers: { Authorization: `token ${this.deps.apiKey}:${this.deps.accessToken}`, "X-Kite-Version": "3" },
    });
    if (!response.ok) {
      throw new Error(`kite instrument master download failed: HTTP ${response.status}`);
    }
    const csv = await response.text();
    const rows = parseInstrumentCsv(csv);
    this.cache = { fetchedOnIstDate: today, rows };
    await mkdir(this.deps.cacheDir, { recursive: true });
    await writeFile(this.cachePath(), JSON.stringify(this.cache), "utf8");
  }

  async search(query: string): Promise<KiteInstrumentRow[]> {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return [];
    await this.ensureFresh();
    return (this.cache?.rows ?? [])
      .filter((row) => row.tradingsymbol.toLowerCase().includes(needle) || row.name.toLowerCase().includes(needle))
      .sort((a, b) => matchRank(a, needle) - matchRank(b, needle))
      .slice(0, MAX_RESULTS);
  }
}
