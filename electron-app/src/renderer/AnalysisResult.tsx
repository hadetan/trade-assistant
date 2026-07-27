import type { AnalysisResult, HistoryMessage } from "../main/ipc/rendererApi";
import { MessageMarkdown } from "./MessageMarkdown";

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

export function AnalysisResultView({ result, history = [] }: AnalysisResultViewProps): JSX.Element | null {
  if (result.mode !== "engine_only") return null;
  const { response } = result;
  const stats: Array<[string, string | number]> = [
    ["Direction", response.direction],
    ["Conviction", response.conviction],
    ["Bullish", response.confluence.bullish_count],
    ["Bearish", response.confluence.bearish_count],
    ["Neutral", response.confluence.neutral_count],
    ["Weighted vote", formatWeightedVote(response.confluence.weighted_vote)],
  ];
  return (
    <section className="analysis-result">
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
      <dl className="confluence">
        {stats.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
