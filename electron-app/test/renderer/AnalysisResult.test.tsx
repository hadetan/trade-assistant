// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AnalysisResultView } from "../../src/renderer/AnalysisResult";
import type { AnalysisResult, HistoryMessage } from "../../src/main/ipc/rendererApi";

afterEach(cleanup);

const result: AnalysisResult = {
  mode: "engine_only",
  instrument: { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", kite_token_asof: "408065" },
  horizon: "positional",
  response: {
    direction: "bullish",
    conviction: "high",
    text: "Overall read: bullish (high conviction).\nConfluence: 4 bullish / 1 bearish / 0 neutral, weighted vote +0.62.",
    confluence: { bullish_count: 4, bearish_count: 1, neutral_count: 0, weighted_vote: 0.62 },
  },
  algo_results: [],
};

describe("AnalysisResultView", () => {
  it("renders the prose through the markdown pipeline and the raw confluence numbers", async () => {
    render(<AnalysisResultView result={result} />);
    expect(await screen.findByText(/Overall read: bullish/)).toBeTruthy();
    expect(screen.getByText("bullish")).toBeTruthy();
    expect(screen.getByText("0.62")).toBeTruthy();
    expect(screen.queryByText(/Past turns in this session/i)).toBeNull();
  });

  it("renders prior turns in a collapsible list when history is supplied", async () => {
    const history: HistoryMessage[] = [
      { role: "user", rendered_text: "earlier question", structured_payload: null, created_at: "t0" },
      { role: "assistant", rendered_text: "earlier answer", structured_payload: null, created_at: "t1" },
    ];
    render(<AnalysisResultView result={result} history={history} />);
    expect(screen.getByText(/Past turns in this session/i)).toBeTruthy();
    expect(await screen.findByText(/earlier question/)).toBeTruthy();
    expect(await screen.findByText(/earlier answer/)).toBeTruthy();
  });
});
