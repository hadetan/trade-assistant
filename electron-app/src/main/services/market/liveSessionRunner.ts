import { LiveCandleTracker } from "./liveCandleTracker";
import type { LiveCandle } from "./liveCandleTracker";
import { intervalMinutes } from "./candleInterval";
import type { CandleInterval } from "./candleInterval";
import { WARMUP_SOURCE } from "./candleWarmup";
import type { KiteTickerClient, TickerConnectionStatus } from "../kite/kiteTicker";
import type { SidecarSupervisor } from "../sidecar/sidecarSupervisor";
import type { HistoryStore } from "../history/historyStore";
import type { CandleWire, AlgoResultWire, ConfluenceWire } from "../sidecar/sidecarProtocol";
import type { AnalysisResult } from "../../ipc/rendererApi";
import { requiredBarsFor } from "../analysis/warmedEnvelope";

export interface LiveTickWire {
  ts: number;
  price: number;
}

export interface LiveInstrument {
  symbol: string;
  exchange: string;
  segment: string;
  instrumentToken: string;
}

// The analyze-time turn this live session keeps up to date. Every recompute
// rewrites the stored message as a *complete* AnalysisResult derived from this
// base, because App.tsx's deriveEngineOnlyView reads that row back as one on
// reopen -- a partial {algo_results, confluence} shape would leave `mode`
// undefined and render nothing for the rest of the session's life.
export type LiveBaseResult = Extract<AnalysisResult, { mode: "engine_only" }>;

export interface StartLiveSessionParams {
  sessionId: string;
  assistantMessageId: string;
  instrument: LiveInstrument;
  interval: CandleInterval;
  baseResult: LiveBaseResult;
}

export interface LiveSessionRunnerDeps {
  ticker: Pick<KiteTickerClient, "subscribe" | "onTick" | "onConnectionChange">;
  sidecar: Pick<SidecarSupervisor, "persistCandles" | "compute" | "readLakeCandles" | "listAlgorithms">;
  history: Pick<HistoryStore, "updateMessage">;
  sendTick: (tick: LiveTickWire) => void;
  sendCandleClose: (payload: { candle: CandleWire; algo_results: AlgoResultWire[]; confluence: ConfluenceWire }) => void;
  sendStatus: (status: TickerConnectionStatus) => void;
}

export interface LiveSessionRunner {
  start(params: StartLiveSessionParams): void;
  stop(): void;
}

function candleWire(candle: LiveCandle): CandleWire {
  return {
    ts: candle.ts,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume,
  };
}

// Kite's full-mode ticks carry the day's running total under `volume_traded`;
// the tracker turns that into a per-bar delta. Undefined (an LTP-mode tick,
// which this runner never subscribes for) means "no reading", not "zero".
function tickCumulativeVolume(tick: Record<string, unknown>): number | undefined {
  return typeof tick.volume_traded === "number" ? tick.volume_traded : undefined;
}

// Kite ticks in "full" mode include exchange_timestamp as an ISO string;
// falls back to Date.now() if a tick ever arrives without one (LTP mode
// wouldn't have it, but this runner always subscribes in "full").
function tickTimestampSeconds(tick: Record<string, unknown>): number {
  const raw = tick.exchange_timestamp;
  if (typeof raw === "string") {
    const parsed = Date.parse(raw);
    if (!Number.isNaN(parsed)) return Math.floor(parsed / 1000);
  }
  return Math.floor(Date.now() / 1000);
}

export function createLiveSessionRunner(deps: LiveSessionRunnerDeps): LiveSessionRunner {
  let activeGeneration = 0;
  let unsubscribes: (() => void)[] = [];

  // The generation bump alone only makes the previous session's handlers inert;
  // it never took them off the ticker, which outlives every session. Dropping
  // the registrations is what actually satisfies P17's "stop() unsubscribes".
  const teardown = (): void => {
    activeGeneration += 1;
    const pending = unsubscribes;
    unsubscribes = [];
    pending.forEach((unsubscribe) => unsubscribe());
  };

  return {
    start(params: StartLiveSessionParams): void {
      teardown();
      const myGeneration = activeGeneration;
      const isActive = (): boolean => myGeneration === activeGeneration;

      const instrumentToken = Number(params.instrument.instrumentToken);
      const tracker = new LiveCandleTracker(intervalMinutes(params.interval));

      deps.ticker.subscribe([instrumentToken], "full");
      const unsubscribeStatus = deps.ticker.onConnectionChange((status) => {
        if (isActive()) deps.sendStatus(status);
      });
      const unsubscribeTick = deps.ticker.onTick((ticks) => {
        if (!isActive()) return;
        const tick = (ticks as Record<string, unknown>[]).find((t) => t.instrument_token === instrumentToken);
        if (!tick || typeof tick.last_price !== "number") return;

        const ts = tickTimestampSeconds(tick);
        deps.sendTick({ ts, price: tick.last_price });

        const closed = tracker.onTick(ts, tick.last_price, tickCumulativeVolume(tick));
        if (closed === null) return;

        void (async () => {
          try {
            const candle = candleWire(closed);
            await deps.sidecar.persistCandles(params.instrument.symbol, params.interval, [candle], WARMUP_SOURCE);
            // compute() is stateless: rust-core keeps only the algorithms whose
            // required_lookback() fits the candles it is handed, so passing just
            // the one bar that closed would qualify zero algorithms and return an
            // all-zero scorecard. Read the whole accumulated history back instead
            // -- the warm-up and this runner write the same lake partition.
            const lake = await deps.sidecar.readLakeCandles(
              params.instrument.symbol,
              params.interval,
              WARMUP_SOURCE,
            );
            if (lake.error != null) throw new Error(lake.error);
            // Same bounding as analyze-time's assembleWarmedEnvelope: path-dependent
            // indicators (Wilder smoothing, GARCH, MA state) disagree across window
            // sizes, so recomputing over the whole unbounded lake partition here
            // would jump the verdict meter away from its analyze-time value on the
            // very first candle close, for reasons unrelated to the market.
            const requiredBars = await requiredBarsFor(deps.sidecar);
            const window = lake.candles.slice(Math.max(0, lake.candles.length - requiredBars));
            const computeResult = await deps.sidecar.compute(
              params.instrument.symbol,
              params.interval,
              "intraday",
              window,
            );
            if (!isActive()) return;
            // direction/conviction/text stay at their analyze-time values: nothing
            // in the live view or the reopen path reads them, and recomputing them
            // here would duplicate deterministicResponseGenerator's derivation.
            const updated: LiveBaseResult = {
              ...params.baseResult,
              algo_results: computeResult.algo_results,
              response: { ...params.baseResult.response, confluence: computeResult.confluence },
            };
            deps.history.updateMessage({
              sessionId: params.sessionId,
              messageId: params.assistantMessageId,
              // listSessions' sidebar preview is the latest message's
              // rendered_text; blanking it would leave this session's row empty.
              renderedText: params.baseResult.response.text,
              structuredPayload: updated,
            });
            deps.sendCandleClose({ candle, algo_results: computeResult.algo_results, confluence: computeResult.confluence });
          } catch (error) {
            console.error(`liveSessionRunner: candle-close handling failed: ${(error as Error).message}`);
          }
        })();
      });

      unsubscribes = [unsubscribeStatus, unsubscribeTick];
    },

    stop(): void {
      teardown();
    },
  };
}
