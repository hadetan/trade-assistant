import type { AnalysisResult, HistoryMessage, ReadinessResult } from "../main/ipc/rendererApi";
import { MessageMarkdown } from "./MessageMarkdown";
import { Card } from "./ui/Card";
import { Badge, directionTone } from "./ui/Badge";
import { Banner } from "./ui/Banner";
import "./AnalysisResult.css";

export interface AnalysisResultViewProps {
  result: AnalysisResult;
  history?: HistoryMessage[];
}

// Matches the precision the prose paragraph renders at (see
// deterministicResponseGenerator.ts's formatVote) so the stat tile can never
// show raw floating-point noise (e.g. 0.6200000000000001) next to prose that
// reads a clean "+0.62".
function formatWeightedVote(vote: number): string {
  return vote.toFixed(2);
}

export function readinessMessage(readiness: Extract<ReadinessResult, { ok: false }>): string {
  switch (readiness.reason) {
    case "kite_not_connected":
      return "Connect your Kite account to fetch live candles for this symbol.";
    case "insufficient_history":
      return `Warming up history — ${readiness.have} of ${readiness.need} candles so far. This symbol needs more trading history before any forecast can run.`;
    case "market_closed":
      return `NSE is closed. Trading resumes ${new Date(readiness.nextOpenAt * 1000).toLocaleString()}.`;
  }
}

export function AnalysisResultView({ result, history = [] }: AnalysisResultViewProps): JSX.Element | null {
  if (result.mode === "engine_only_blocked") {
    return <Banner variant="info">{readinessMessage(result.readiness)}</Banner>;
  }
  if (result.mode !== "engine_only") return null;
  const { response } = result;

  return (
    <Card className="analysis-result">
      {history.length > 0 && (
        <details className="session-history">
          <summary>Past turns in this session</summary>
          <ul>
            {history.map((message, index) => (
              <li key={index} className={`message message-${message.role}`}>
                <MessageMarkdown text={message.rendered_text} />
              </li>
            ))}
          </ul>
        </details>
      )}
      <MessageMarkdown text={response.text} />
      <div className="confluence">
        <Badge tone={directionTone(response.direction)}>
          {response.direction} · {response.conviction}
        </Badge>
        <Badge tone="bullish">{response.confluence.bullish_count} bullish</Badge>
        <Badge tone="bearish">{response.confluence.bearish_count} bearish</Badge>
        <Badge tone="neutral">{response.confluence.neutral_count} neutral</Badge>
        <span className="confluence-vote">weighted vote {formatWeightedVote(response.confluence.weighted_vote)}</span>
      </div>
    </Card>
  );
}
