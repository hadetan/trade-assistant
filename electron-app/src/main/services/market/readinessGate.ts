import type { KiteClient } from "../kite/kiteClient";
import type { SidecarSupervisor } from "../sidecar/sidecarSupervisor";
import type { KiteSessionStatus } from "../../ipc/rendererApi";
import { requiredBarsFor } from "../analysis/warmedEnvelope";
import { topUpCandles } from "./candleWarmup";
import { isHolidayCalendarCovered, isWithinSessionHours, nextSessionOpen } from "./tradingCalendar";
import { NSE_HOLIDAY_CALENDAR_SOURCE } from "./nseHolidays";
import type { CandleInterval } from "./candleInterval";

export type ReadinessResult =
  | { ok: true }
  | { ok: false; reason: "kite_not_connected" }
  | { ok: false; reason: "insufficient_history"; have: number; need: number }
  | { ok: false; reason: "market_closed"; nextOpenAt: number };

export interface ReadinessDeps {
  kiteStatus: () => KiteSessionStatus;
  kite: Pick<KiteClient, "getHistoricalData"> | null;
  sidecar: Pick<SidecarSupervisor, "persistCandles" | "readLakeCandles" | "listAlgorithms">;
}

export interface ReadinessParams {
  symbol: string;
  instrumentToken: string;
  interval: CandleInterval;
  now: Date;
}

const warnedYears = new Set<number>();

function warnOnceAboutCalendarCoverage(year: number): void {
  if (isHolidayCalendarCovered(year) || warnedYears.has(year)) return;
  warnedYears.add(year);
  console.warn(
    `market: no NSE holiday calendar bundled for ${year}; falling back to weekends-only. ` +
      `Refresh nseHolidays.ts from ${NSE_HOLIDAY_CALENDAR_SOURCE}.`,
  );
}

export async function checkEngineOnlyReadiness(
  deps: ReadinessDeps,
  params: ReadinessParams,
): Promise<ReadinessResult> {
  // Fixed order, short-circuiting on the first failure: exactly one message is
  // ever produced, never a checklist (P13§2 locked decision 3). Nothing else
  // runs without Kite -- there would be no way to fetch anything to check.
  if (deps.kiteStatus() !== "authenticated" || deps.kite === null) {
    return { ok: false, reason: "kite_not_connected" };
  }

  const need = await requiredBarsFor(deps.sidecar);
  const { candles } = await topUpCandles(
    { kite: deps.kite, sidecar: deps.sidecar },
    {
      symbol: params.symbol,
      instrumentToken: params.instrumentToken,
      interval: params.interval,
      requiredBars: need,
      now: params.now,
    },
  );
  if (candles.length < need) {
    return { ok: false, reason: "insufficient_history", have: candles.length, need };
  }

  warnOnceAboutCalendarCoverage(params.now.getFullYear());
  if (!isWithinSessionHours(params.now)) {
    return { ok: false, reason: "market_closed", nextOpenAt: nextSessionOpen(params.now) };
  }

  return { ok: true };
}
