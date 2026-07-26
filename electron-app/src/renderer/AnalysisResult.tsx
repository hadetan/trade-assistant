import type { AnalysisResult } from "../main/ipc/rendererApi";

export interface AnalysisResultViewProps {
  result: AnalysisResult;
}

// Matches the precision the prose paragraph renders at (see
// deterministicResponseGenerator.ts's formatVote) so the stat tile can never
// show raw floating-point noise (e.g. 0.6200000000000001) next to prose that
// reads a clean "+0.62".
function formatWeightedVote(vote: number): string {
  return vote.toFixed(2);
}

export function AnalysisResultView({ result }: AnalysisResultViewProps): JSX.Element {
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
      <p className="prose">{response.text}</p>
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
