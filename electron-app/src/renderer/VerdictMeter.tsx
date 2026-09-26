import "./VerdictMeter.css";

export interface VerdictMeterProps {
  weightedVote: number; // range [-1, 1]; positive = bullish, negative = bearish
}

// Direction is encoded by which side of the fixed center line the fill
// extends toward (and the arrow glyph's own direction), never by color
// alone -- this app's real --bullish/--bearish tokens fail a red-green
// colorblind separation check (P17§6), and this meter has no text label to
// fall back on the way older, prose-based verdict text did.
export function VerdictMeter({ weightedVote }: VerdictMeterProps): JSX.Element {
  const clamped = Math.max(-1, Math.min(1, weightedVote));
  const direction = clamped > 0 ? "bullish" : clamped < 0 ? "bearish" : "neutral";
  const widthPercent = Math.abs(clamped) * 50;

  return (
    <div className="verdict-meter" role="img" aria-label={`Confluence ${direction}, strength ${Math.abs(clamped).toFixed(2)}`}>
      <div className="verdict-meter-track">
        <div className="verdict-meter-center" />
        <div
          className={`verdict-meter-fill verdict-meter-fill-${direction}`}
          data-direction={direction}
          style={{ width: `${widthPercent}%` }}
        >
          {direction !== "neutral" && (
            <span className={`verdict-meter-arrow verdict-meter-arrow-${direction}`} aria-hidden="true" />
          )}
        </div>
      </div>
    </div>
  );
}
