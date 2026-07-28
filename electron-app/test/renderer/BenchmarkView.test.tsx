// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/renderer/benchmarkChart", () => ({ createBenchmarkChart: vi.fn(() => ({ dispose: vi.fn() })) }));

import { BenchmarkView } from "../../src/renderer/BenchmarkView";
import type { BenchmarkResult, LakeSymbolEntry, RendererApi } from "../../src/main/ipc/rendererApi";

afterEach(cleanup);

const DAY_ENTRY: LakeSymbolEntry = {
  symbol: "NSE:INFY",
  timeframe: "day",
  source: "bhavcopy",
  fromTs: 1_690_000_000,
  toTs: 1_710_000_000,
  candleCount: 240,
  horizon: "positional",
};

function api(overrides: Partial<Pick<RendererApi, "listLakeSymbols" | "runBenchmark" | "copyBenchmarkResult">> = {}) {
  return {
    listLakeSymbols: vi.fn().mockResolvedValue([DAY_ENTRY]),
    runBenchmark: vi.fn(),
    copyBenchmarkResult: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function resultWith(outcomes: Array<BenchmarkResult["decisionPoints"][number]["outcome"]>): BenchmarkResult {
  return {
    params: { symbol: "NSE:INFY", timeframe: "day", source: "bhavcopy", horizon: "positional", cadence: { mode: "session_close" }, lookaheadBars: 5, fromTs: 0, toTs: 0 },
    candles: [{ ts: 1, open: 1, high: 2, low: 0.5, close: 1.5, volume: 100 }],
    decisionPoints: outcomes.map((outcome, i) => ({
      frontierIndex: i,
      ts: i + 1,
      closeAtFrontier: 1,
      closeAtLookahead: 1,
      realizedReturn: 0,
      direction: "bullish",
      conviction: "medium",
      responseText: "",
      algoResults: [],
      confluence: { bullish_count: 0, bearish_count: 0, neutral_count: 0, weighted_vote: 0 },
      outcome,
    })),
  };
}

describe("BenchmarkView", () => {
  it("shows the no-data message when the lake is empty", async () => {
    render(<BenchmarkView api={api({ listLakeSymbols: vi.fn().mockResolvedValue([]) })} />);
    expect(await screen.findByText(/no data ingested yet/i)).toBeTruthy();
  });

  it("renders each lake entry with its derived horizon and covered range", async () => {
    render(<BenchmarkView api={api()} />);
    const option = await screen.findByRole("button", { name: /NSE:INFY/ });
    expect(option.textContent).toMatch(/day/);
    expect(option.textContent).toMatch(/positional/);
    expect(option.textContent).toMatch(/240/);
  });

  it("prefills the horizon-appropriate cadence and lookahead on selection", async () => {
    render(<BenchmarkView api={api()} />);
    fireEvent.click(await screen.findByRole("button", { name: /NSE:INFY/ }));
    const lookahead = (await screen.findByLabelText(/lookahead bars/i)) as HTMLInputElement;
    expect(lookahead.value).toBe("5"); // positional default
    expect(screen.getByText(/session_close/i)).toBeTruthy();
  });

  it("runs the benchmark with the assembled params", async () => {
    const deps = api({ runBenchmark: vi.fn().mockResolvedValue(resultWith([])) });
    render(<BenchmarkView api={deps} />);
    fireEvent.click(await screen.findByRole("button", { name: /NSE:INFY/ }));
    fireEvent.click(await screen.findByRole("button", { name: /run benchmark/i }));
    await waitFor(() => expect(deps.runBenchmark).toHaveBeenCalledTimes(1));
    expect(deps.runBenchmark.mock.calls[0][0]).toMatchObject({
      symbol: "NSE:INFY",
      timeframe: "day",
      source: "bhavcopy",
      horizon: "positional",
      cadence: { mode: "session_close" },
      lookaheadBars: 5,
    });
  });

  it("renders the summary strip counts and hit-rate after a run", async () => {
    const deps = api({ runBenchmark: vi.fn().mockResolvedValue(resultWith(["correct", "correct", "incorrect", "neutral"])) });
    render(<BenchmarkView api={deps} />);
    fireEvent.click(await screen.findByRole("button", { name: /NSE:INFY/ }));
    fireEvent.click(await screen.findByRole("button", { name: /run benchmark/i }));
    // 2 correct / (2 correct + 1 incorrect) = 67%.
    expect(await screen.findByText(/67%/)).toBeTruthy();
    expect(screen.getByText(/2 correct/i)).toBeTruthy();
  });

  it("shows a zero-decision-points strip instead of dividing by zero", async () => {
    const deps = api({ runBenchmark: vi.fn().mockResolvedValue(resultWith([])) });
    render(<BenchmarkView api={deps} />);
    fireEvent.click(await screen.findByRole("button", { name: /NSE:INFY/ }));
    fireEvent.click(await screen.findByRole("button", { name: /run benchmark/i }));
    expect(await screen.findByText(/0 decision points/i)).toBeTruthy();
  });
});
