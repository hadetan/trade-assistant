import type { AnalysisEnvelope, Conviction, Direction } from "./contracts";
import type { AlgoResultWire, ConfluenceWire } from "../sidecar/sidecarProtocol";

export interface DeterministicResponse {
  direction: Direction;
  conviction: Conviction;
  text: string;
  confluence: ConfluenceWire;
}

const DIRECTION_DEADBAND = 0.05;
const CONCISE_TOP_N = 3;
const CLOSING_LINE = "Descriptive analysis only — verify every figure in Kite yourself before making any decision.";

function directionFromVote(vote: number): Direction {
  if (vote > DIRECTION_DEADBAND) return "bullish";
  if (vote < -DIRECTION_DEADBAND) return "bearish";
  return "neutral";
}

function convictionFromCounts(confluence: ConfluenceWire): Conviction {
  const total = confluence.bullish_count + confluence.bearish_count + confluence.neutral_count;
  if (total === 0) return "low";
  const ratio = Math.max(confluence.bullish_count, confluence.bearish_count, confluence.neutral_count) / total;
  if (ratio >= 0.66) return "high";
  if (ratio >= 0.5) return "medium";
  return "low";
}

function formatVote(vote: number): string {
  return `${vote >= 0 ? "+" : ""}${vote.toFixed(2)}`;
}

// direction (vote deadband) and conviction (count-agreement ratio) are
// deliberately independent signals (§9.2: conviction reflects the vote's own
// agreement/strength, not a re-derivation of direction) — but read together
// unqualified, "neutral (high conviction)" reads as a contradiction. Naming
// both facts explicitly instead of concatenating them avoids that without
// changing either value.
function headlineFor(direction: Direction, conviction: Conviction): string {
  if (direction === "neutral" && conviction !== "low") {
    return `Overall read: neutral — the net weighted vote sits near zero even though ${conviction}-conviction algorithms are in signal agreement.`;
  }
  return `Overall read: ${direction} (${conviction} conviction).`;
}

function rankByMagnitude(results: AlgoResultWire[]): AlgoResultWire[] {
  return [...results].sort((a, b) => {
    const byMagnitude = Math.abs(b.magnitude) - Math.abs(a.magnitude);
    return byMagnitude !== 0 ? byMagnitude : b.confidence - a.confidence;
  });
}

function algoLine(result: AlgoResultWire): string {
  const direction = result.direction.toLowerCase();
  return `${result.algo_id} reads a ${direction} signal (confidence ${result.confidence.toFixed(2)}): ${result.evidence.join("; ")}`;
}

export function generateDeterministicResponse(
  envelope: AnalysisEnvelope,
  opts: { variant?: "concise" | "full" } = {},
): DeterministicResponse {
  const variant = opts.variant ?? "concise";
  const confluence = envelope.confluence;
  const direction = directionFromVote(confluence.weighted_vote);
  const conviction = convictionFromCounts(confluence);

  const ranked = rankByMagnitude(envelope.algo_results);
  const cited = variant === "full" ? ranked : ranked.slice(0, CONCISE_TOP_N);

  const headline = headlineFor(direction, conviction);
  const summary =
    `Confluence: ${confluence.bullish_count} bullish / ${confluence.bearish_count} bearish / ` +
    `${confluence.neutral_count} neutral, weighted vote ${formatVote(confluence.weighted_vote)}.`;

  const text = [headline, ...cited.map(algoLine), summary, CLOSING_LINE].join("\n");
  return { direction, conviction, text, confluence };
}
