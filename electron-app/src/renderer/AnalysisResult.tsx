import type { AnalysisResult } from "../main/ipc/rendererApi";

export interface AnalysisResultViewProps {
  result: AnalysisResult;
}

export function AnalysisResultView({ result }: AnalysisResultViewProps): JSX.Element {
  const { response } = result;
  return (
    <section className="analysis-result">
      <p className="prose">{response.text}</p>
      <dl className="confluence">
        <div>
          <dt>Direction</dt>
          <dd>{response.direction}</dd>
        </div>
        <div>
          <dt>Conviction</dt>
          <dd>{response.conviction}</dd>
        </div>
        <div>
          <dt>Bullish</dt>
          <dd>{response.confluence.bullish_count}</dd>
        </div>
        <div>
          <dt>Bearish</dt>
          <dd>{response.confluence.bearish_count}</dd>
        </div>
        <div>
          <dt>Neutral</dt>
          <dd>{response.confluence.neutral_count}</dd>
        </div>
        <div>
          <dt>Weighted vote</dt>
          <dd>{response.confluence.weighted_vote}</dd>
        </div>
      </dl>
    </section>
  );
}
