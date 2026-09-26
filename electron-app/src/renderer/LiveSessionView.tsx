import { useEffect, useRef, useState } from "react";
import { createLiveChart } from "./liveChart";
import { VerdictMeter } from "./VerdictMeter";
import { intervalMinutes } from "../main/services/market/candleInterval";
import type { CandleInterval } from "../main/services/market/candleInterval";
import type { CandleWire, ConfluenceWire } from "../main/services/sidecar/sidecarProtocol";
import type { InstrumentSelection, RendererApi } from "../main/ipc/rendererApi";
import "./LiveSessionView.css";

export interface LiveSessionViewProps {
  sessionId: string;
  assistantMessageId: string;
  instrument: InstrumentSelection;
  interval: CandleInterval;
  initialCandles: CandleWire[];
  initialConfluence: ConfluenceWire;
  bridge: Pick<RendererApi, "startLiveSession" | "stopLiveSession" | "onLiveTick" | "onLiveCandleClose" | "onLiveStatus">;
}

export function LiveSessionView(props: LiveSessionViewProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const [weightedVote, setWeightedVote] = useState(props.initialConfluence.weighted_vote);

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createLiveChart(containerRef.current, props.initialCandles);
    const intervalSeconds = intervalMinutes(props.interval) * 60;

    props.bridge.onLiveTick((tick) => chart.applyTick(tick, intervalSeconds));
    props.bridge.onLiveCandleClose((payload) => {
      chart.applyClosedCandle(payload.candle);
      setWeightedVote(payload.confluence.weighted_vote);
    });
    props.bridge.onLiveStatus(() => {
      // Connection status surfaces via the existing StatusDot/banner pattern
      // at the App shell level (P17§9), not inside this view -- nothing to
      // do here beyond receiving the event so it doesn't go unhandled.
    });

    void props.bridge.startLiveSession({
      sessionId: props.sessionId,
      assistantMessageId: props.assistantMessageId,
      instrument: props.instrument,
      interval: props.interval,
    });

    return () => {
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
