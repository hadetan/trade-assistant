import { useEffect, useRef, useState } from "react";
import { createLiveChart } from "./liveChart";
import { VerdictMeter } from "./VerdictMeter";
import { Button } from "./ui/Button";
import { StatusDot } from "./ui/StatusDot";
import type { StatusDotTone } from "./ui/StatusDot";
import { intervalMinutes } from "../main/services/market/candleInterval";
import type { CandleInterval } from "../main/services/market/candleInterval";
import type { CandleWire, ConfluenceWire } from "../main/services/sidecar/sidecarProtocol";
import type { InstrumentSelection, RendererApi, TickerConnectionStatus } from "../main/ipc/rendererApi";
import type { LiveBaseResult } from "../main/services/market/liveSessionRunner";
import "./LiveSessionView.css";

// Connection chrome, not the market call: the "no prose" rule is about never
// narrating the verdict, and the app already labels its status dots this way
// in the sidebar ("Kite authenticated").
const STATUS_CHROME: Record<TickerConnectionStatus, { tone: StatusDotTone; label: string }> = {
  connected: { tone: "done", label: "Live" },
  reconnecting: { tone: "running", label: "Reconnecting…" },
  error: { tone: "error", label: "Disconnected" },
};

export interface LiveSessionViewProps {
  sessionId: string;
  assistantMessageId: string;
  instrument: InstrumentSelection;
  interval: CandleInterval;
  initialCandles: CandleWire[];
  initialConfluence: ConfluenceWire;
  baseResult: LiveBaseResult;
  bridge: Pick<RendererApi, "startLiveSession" | "stopLiveSession" | "onLiveTick" | "onLiveCandleClose" | "onLiveStatus">;
}

export function LiveSessionView(props: LiveSessionViewProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const [weightedVote, setWeightedVote] = useState(props.initialConfluence.weighted_vote);
  // The ticker connects at login and only emits on a *change* thereafter, so a
  // session that starts normally never receives a "connected" event of its own.
  const [status, setStatus] = useState<TickerConnectionStatus>("connected");

  const startSession = (): void => {
    void props.bridge.startLiveSession({
      sessionId: props.sessionId,
      assistantMessageId: props.assistantMessageId,
      instrument: props.instrument,
      interval: props.interval,
      baseResult: props.baseResult,
    });
  };

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createLiveChart(containerRef.current, props.initialCandles);
    const intervalSeconds = intervalMinutes(props.interval) * 60;

    // Belt and braces alongside the unsubscribes below: a handler that has been
    // removed can still be mid-dispatch, and one that throws there would abort
    // every listener queued after it on the same channel.
    let disposed = false;

    const unsubscribeTick = props.bridge.onLiveTick((tick) => {
      if (disposed) return;
      chart.applyTick(tick, intervalSeconds);
    });
    const unsubscribeCandleClose = props.bridge.onLiveCandleClose((payload) => {
      if (disposed) return;
      chart.applyClosedCandle(payload.candle);
      setWeightedVote(payload.confluence.weighted_vote);
    });
    const unsubscribeStatus = props.bridge.onLiveStatus((next) => {
      if (disposed) return;
      setStatus(next);
    });

    startSession();

    return () => {
      disposed = true;
      unsubscribeTick();
      unsubscribeCandleClose();
      unsubscribeStatus();
      void props.bridge.stopLiveSession();
      chart.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- session identity (sessionId) is this effect's real dependency; re-running it on every prop identity change would restart the live session unnecessarily.
  }, [props.sessionId]);

  const chrome = STATUS_CHROME[status];

  return (
    <div className="live-session-view">
      <div className="live-session-status">
        <StatusDot tone={chrome.tone} label={chrome.label} />
        {status === "error" && (
          // The readiness gate already passed once to get this view on screen;
          // this only re-runs the runner's subscribe flow.
          <Button variant="secondary" size="sm" onClick={startSession}>
            Reconnect
          </Button>
        )}
      </div>
      <div className="live-session-chart" ref={containerRef} />
      <VerdictMeter weightedVote={weightedVote} />
    </div>
  );
}
