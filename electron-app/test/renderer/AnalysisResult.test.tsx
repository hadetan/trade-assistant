// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
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
  it("renders the prose through the markdown pipeline inside a Card", async () => {
    const { container } = render(<AnalysisResultView result={result} />);
    expect(await screen.findByText(/Overall read: bullish/)).toBeTruthy();
    expect(container.querySelector(".card")).toBeTruthy();
    expect(screen.queryByText(/Past turns in this session/i)).toBeNull();
  });

  it("renders the confluence counts as a Badge row using the direction/status tone palette", () => {
    const { container } = render(<AnalysisResultView result={result} />);
    const confluence = within(container.querySelector(".confluence") as HTMLElement);
    expect(confluence.getByText(/bullish · high/i)).toBeTruthy();
    expect(confluence.getByText(/4 bullish/)).toBeTruthy();
    expect(confluence.getByText(/1 bearish/)).toBeTruthy();
    expect(confluence.getByText(/0 neutral/)).toBeTruthy();
    expect(confluence.getByText(/weighted vote 0\.62/)).toBeTruthy();
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
