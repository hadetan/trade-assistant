import { useEffect, useRef, useState } from "react";
import { createLiveChart } from "./liveChart";
import { VerdictMeter } from "./VerdictMeter";
import { intervalMinutes } from "../main/services/market/candleInterval";
import type { CandleInterval } from "../main/services/market/candleInterval";
import type { CandleWire, ConfluenceWire } from "../main/services/sidecar/sidecarProtocol";
import type { InstrumentSelection, RendererApi } from "../main/ipc/rendererApi";
import type { LiveBaseResult } from "../main/services/market/liveSessionRunner";
import "./LiveSessionView.css";

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

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createLiveChart(containerRef.current, props.initialCandles);
    const intervalSeconds = intervalMinutes(props.interval) * 60;

    // ipcRenderer.on has no matching .off() exposed anywhere in this app's IPC
    // layer (see rendererApi.ts/preload.ts), so a stale handler from a disposed
    // chart would otherwise stay registered forever and can throw on the next
    // real event, aborting every listener queued after it in that dispatch.
    // This flag makes every handler below a permanent no-op the instant cleanup
    // runs, regardless of how many times this effect re-runs.
    let disposed = false;

    props.bridge.onLiveTick((tick) => {
      if (disposed) return;
      chart.applyTick(tick, intervalSeconds);
    });
    props.bridge.onLiveCandleClose((payload) => {
      if (disposed) return;
      chart.applyClosedCandle(payload.candle);
      setWeightedVote(payload.confluence.weighted_vote);
    });
    props.bridge.onLiveStatus(() => {
      if (disposed) return;
      // Connection status surfaces via the existing StatusDot/banner pattern
      // at the App shell level (P17§9), not inside this view -- nothing to
      // do here beyond receiving the event so it doesn't go unhandled.
    });

    void props.bridge.startLiveSession({
      sessionId: props.sessionId,
      assistantMessageId: props.assistantMessageId,
      instrument: props.instrument,
      interval: props.interval,
      baseResult: props.baseResult,
    });

    return () => {
      disposed = true;
      void props.bridge.stopLiveSession();
      chart.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- session identity (sessionId) is this effect's real dependency; re-running it on every prop identity change would restart the live session unnecessarily.
  }, [props.sessionId]);

  return (
    <div className="live-session-view">
      <div className="live-session-chart" ref={containerRef} />
      <VerdictMeter weightedVote={weightedVote} />
    </div>
  );
}
