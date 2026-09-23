// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/renderer/benchmarkChart", () => ({ createBenchmarkChart: vi.fn(() => ({ dispose: vi.fn() })) }));

import { BenchmarkView } from "../../src/renderer/BenchmarkView";
import type { AlgorithmEntry, BenchmarkProgress, BenchmarkResult, LakeSymbolEntry, RendererApi } from "../../src/main/ipc/rendererApi";

afterEach(cleanup);

const DAY_ENTRY: LakeSymbolEntry = {
  symbol: "NSE:INFY",
  timeframe: "day",
  source: "bhavcopy",
  fromTs: 1_690_000_000,
  toTs: 1_710_000_000,
  candleCount: 240,
  firstSeenFromTs: 1_690_000_000,
  firstSeenToTs: 1_710_000_000,
  firstSeenCandleCount: 240,
  horizon: "positional",
};

// A backfilled entry: live fromTs/toTs/candleCount have moved far beyond what
// the user originally saw. Any test using this fixture would fail if the
// picker's display were wired to the live fields instead of the
// first_seen_* ones.
const BACKFILLED_ENTRY: LakeSymbolEntry = {
  symbol: "NSE:20MICRONS",
  timeframe: "day",
  source: "bhavcopy",
  fromTs: 1_670_000_000,
  toTs: 1_710_000_000,
  candleCount: 88,
  firstSeenFromTs: 1_705_000_000,
  firstSeenToTs: 1_705_800_000,
  firstSeenCandleCount: 8,
  horizon: "positional",
};

const ALGORITHMS: AlgorithmEntry[] = [
  { id: "sma", cost: "fast", requiredLookback: 20 },
  { id: "kronos", cost: "slow", requiredLookback: 256 },
];

function api(
  overrides: Partial<Pick<RendererApi, "listLakeSymbols" | "listAlgorithms" | "runBenchmark" | "cancelBenchmark" | "copyBenchmarkResult" | "onBenchmarkProgress">> = {},
) {
  return {
    listLakeSymbols: vi.fn().mockResolvedValue([DAY_ENTRY]),
    listAlgorithms: vi.fn().mockResolvedValue(ALGORITHMS),
    runBenchmark: vi.fn(),
    cancelBenchmark: vi.fn().mockResolvedValue(undefined),
    copyBenchmarkResult: vi.fn().mockResolvedValue(undefined),
    onBenchmarkProgress: vi.fn(),
    ...overrides,
  };
}

function resultWith(outcomes: Array<BenchmarkResult["decisionPoints"][number]["outcome"]>, cancelled = false): BenchmarkResult {
  return {
    params: { symbol: "NSE:INFY", timeframe: "day", source: "bhavcopy", horizon: "positional", algoId: "sma", lookaheadBars: 5, fromTs: 1_700_000_000, toTs: 1_700_086_400 },
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
    cancelled,
  };
}

async function selectEntryAndAlgo(): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: /NSE:INFY/ }));
  fireEvent.click(await screen.findByRole("button", { name: /^sma/i }));
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

  it("displays the picker list's first-seen extent, not the live backfilled extent", async () => {
    render(<BenchmarkView api={api({ listLakeSymbols: vi.fn().mockResolvedValue([BACKFILLED_ENTRY]) })} />);
    const option = await screen.findByRole("button", { name: /NSE:20MICRONS/ });
    expect(option.textContent).toContain("8 bars");
    expect(option.textContent).not.toContain("88 bars");
    expect(option.textContent).toContain(new Date(BACKFILLED_ENTRY.firstSeenFromTs * 1000).toISOString().slice(0, 10));
    expect(option.textContent).not.toContain(new Date(BACKFILLED_ENTRY.fromTs * 1000).toISOString().slice(0, 10));
  });

  it("renders the algorithm picker tagged fast/slow and tags a forecaster as an ML forecaster", async () => {
    render(<BenchmarkView api={api()} />);
    fireEvent.click(await screen.findByRole("button", { name: /NSE:INFY/ }));
    expect(await screen.findByText(/kronos/i)).toBeTruthy();
    expect(screen.getByText(/slow \(ml forecaster\)/i)).toBeTruthy();
  });

  it("keeps the Run button disabled until an algorithm is selected", async () => {
    render(<BenchmarkView api={api()} />);
    fireEvent.click(await screen.findByRole("button", { name: /NSE:INFY/ }));
    const runButton = await screen.findByRole("button", { name: /run benchmark/i });
    expect(runButton).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: /^sma/i }));
    expect(runButton).toHaveProperty("disabled", false);
  });

  it("runs the benchmark with the selected symbol and algorithm, no date or lookahead supplied", async () => {
    const deps = api({ runBenchmark: vi.fn().mockResolvedValue(resultWith([])) });
    render(<BenchmarkView api={deps} />);
    await selectEntryAndAlgo();
    fireEvent.click(await screen.findByRole("button", { name: /run benchmark/i }));
    await waitFor(() => expect(deps.runBenchmark).toHaveBeenCalledTimes(1));
    expect(deps.runBenchmark.mock.calls[0][0]).toEqual({
      symbol: "NSE:INFY",
      timeframe: "day",
      source: "bhavcopy",
      horizon: "positional",
      algoId: "sma",
      requiredLookback: 20,
    });
  });

  it("renders the summary strip counts and hit-rate after a run", async () => {
    const deps = api({ runBenchmark: vi.fn().mockResolvedValue(resultWith(["correct", "correct", "incorrect", "neutral"])) });
    render(<BenchmarkView api={deps} />);
    await selectEntryAndAlgo();
    fireEvent.click(await screen.findByRole("button", { name: /run benchmark/i }));
    // 2 correct / (2 correct + 1 incorrect) = 67%.
    expect(await screen.findByText(/67%/)).toBeTruthy();
    expect(screen.getByText(/2 correct/i)).toBeTruthy();
  });

  it("shows a zero-decision-points strip instead of dividing by zero", async () => {
    const deps = api({ runBenchmark: vi.fn().mockResolvedValue(resultWith([])) });
    render(<BenchmarkView api={deps} />);
    await selectEntryAndAlgo();
    fireEvent.click(await screen.findByRole("button", { name: /run benchmark/i }));
    expect(await screen.findByText(/0 decision points/i)).toBeTruthy();
  });

  it("auto-opens the first decision point's explanation instead of hiding it behind an undiscoverable click", async () => {
    const deps = api({ runBenchmark: vi.fn().mockResolvedValue(resultWith(["neutral"])) });
    render(<BenchmarkView api={deps} />);
    await selectEntryAndAlgo();
    fireEvent.click(await screen.findByRole("button", { name: /run benchmark/i }));
    expect(await screen.findByText(/bullish \(medium conviction\) — neutral/i)).toBeTruthy();
  });

  it("hints that other markers on the chart can be clicked for their own explanation", async () => {
    const deps = api({ runBenchmark: vi.fn().mockResolvedValue(resultWith(["neutral", "correct"])) });
    render(<BenchmarkView api={deps} />);
    await selectEntryAndAlgo();
    fireEvent.click(await screen.findByRole("button", { name: /run benchmark/i }));
    expect(await screen.findByText(/click a marker/i)).toBeTruthy();
  });

  it("renders a Cancelled banner in place of an error when the result is cancelled", async () => {
    const deps = api({ runBenchmark: vi.fn().mockResolvedValue(resultWith([], true)) });
    render(<BenchmarkView api={deps} />);
    await selectEntryAndAlgo();
    fireEvent.click(await screen.findByRole("button", { name: /run benchmark/i }));
    expect(await screen.findByText(/cancelled — partial results/i)).toBeTruthy();
  });

  it("shows a loading spinner while the lake list is in flight", () => {
    render(<BenchmarkView api={api({ listLakeSymbols: vi.fn(() => new Promise(() => {})) })} />);
    expect(screen.getByRole("status")).toBeTruthy();
  });

  it("marks the clicked lake entry as selected so a click is never visually silent", async () => {
    render(<BenchmarkView api={api()} />);
    const option = await screen.findByRole("button", { name: /NSE:INFY/ });
    expect(option).toHaveProperty("ariaPressed", "false");
    fireEvent.click(option);
    expect(option).toHaveProperty("ariaPressed", "true");
  });

  it("shows an error instead of hanging on the spinner forever when the initial lake fetch rejects", async () => {
    render(<BenchmarkView api={api({ listLakeSymbols: vi.fn().mockRejectedValue(new Error("sidecar unreachable")) })} />);
    expect(await screen.findByText(/sidecar unreachable/i)).toBeTruthy();
  });

  it("shows an error instead of hanging on the spinner forever when the initial algorithm fetch rejects", async () => {
    render(<BenchmarkView api={api({ listAlgorithms: vi.fn().mockRejectedValue(new Error("sidecar unreachable")) })} />);
    expect(await screen.findByText(/sidecar unreachable/i)).toBeTruthy();
  });

  it("shows a fixed progress pill reflecting onBenchmarkProgress updates while running", async () => {
    let progressHandler: ((p: BenchmarkProgress) => void) | undefined;
    const runBenchmark = vi.fn(() => new Promise<BenchmarkResult>(() => {})); // never resolves -- keeps `running` true
    const deps = api({
      runBenchmark,
      onBenchmarkProgress: vi.fn((handler: (p: BenchmarkProgress) => void) => {
        progressHandler = handler;
      }),
    });
    render(<BenchmarkView api={deps} />);
    await selectEntryAndAlgo();
    fireEvent.click(await screen.findByRole("button", { name: /run benchmark/i }));
    await waitFor(() => expect(runBenchmark).toHaveBeenCalledTimes(1));
    progressHandler?.({ phase: "run", index: 3, total: 10 });
    expect(await screen.findByText(/bar 3\/10/i)).toBeTruthy();
  });

  it("calls cancelBenchmark when Stop is clicked while a run is in flight", async () => {
    const runBenchmark = vi.fn(() => new Promise<BenchmarkResult>(() => {}));
    const deps = api({ runBenchmark });
    render(<BenchmarkView api={deps} />);
    await selectEntryAndAlgo();
    fireEvent.click(await screen.findByRole("button", { name: /run benchmark/i }));
    await waitFor(() => expect(runBenchmark).toHaveBeenCalledTimes(1));
    fireEvent.click(await screen.findByRole("button", { name: /^stop$/i }));
    expect(deps.cancelBenchmark).toHaveBeenCalledTimes(1);
  });

  it("labels the progress pill by phase, so a long first-time backfill does not read as a stalled bar count", async () => {
    let progressHandler: ((p: BenchmarkProgress) => void) | undefined;
    const runBenchmark = vi.fn(() => new Promise<BenchmarkResult>(() => {})); // never resolves -- keeps `running` true
    const deps = api({
      runBenchmark,
      onBenchmarkProgress: vi.fn((handler: (p: BenchmarkProgress) => void) => {
        progressHandler = handler;
      }),
    });
    render(<BenchmarkView api={deps} />);
    await selectEntryAndAlgo();
    fireEvent.click(await screen.findByRole("button", { name: /run benchmark/i }));
    await waitFor(() => expect(runBenchmark).toHaveBeenCalledTimes(1));

    progressHandler?.({ phase: "backfill", index: 143, total: 256 });
    expect(await screen.findByText(/backfilling history — 143\/256 days/i)).toBeTruthy();

    progressHandler?.({ phase: "run", index: 3, total: 8 });
    expect(await screen.findByText(/bar 3\/8/i)).toBeTruthy();
    expect(screen.queryByText(/backfilling history/i)).toBeNull();
  });

  it("renders one insufficient-history banner in place of the summary strip and chart", async () => {
    const insufficient: BenchmarkResult = {
      params: { symbol: "NSE:ZYDUSWELL", timeframe: "day", source: "bhavcopy", horizon: "positional", algoId: "kronos", lookaheadBars: 5, fromTs: 0, toTs: 0 },
      candles: [],
      decisionPoints: [],
      cancelled: false,
      insufficientHistory: { have: 8, need: 256, reason: "symbol_history" },
    };
    const deps = api({ runBenchmark: vi.fn().mockResolvedValue(insufficient) });
    const { container } = render(<BenchmarkView api={deps} />);
    await selectEntryAndAlgo();
    fireEvent.click(await screen.findByRole("button", { name: /run benchmark/i }));

    await waitFor(() => expect(container.textContent).toContain("NSE:ZYDUSWELL doesn't have enough trading history for this test."));
    expect(container.textContent).toContain("Try a different stock.");
    expect(container.textContent).not.toMatch(/archive/i);
    expect(container.textContent).not.toContain("256");
    expect(screen.queryByText(/0 decision points/i)).toBeNull();
    expect(screen.queryByText(/copy raw result/i)).toBeNull();
  });

  it("says the archive could not be reached, not that the symbol is young, when the walk hit the closed-day cap", async () => {
    const unreachable: BenchmarkResult = {
      params: { symbol: "NSE:ZYDUSWELL", timeframe: "day", source: "bhavcopy", horizon: "positional", algoId: "kronos", lookaheadBars: 5, fromTs: 0, toTs: 0 },
      candles: [],
      decisionPoints: [],
      cancelled: false,
      insufficientHistory: { have: 41, need: 256, reason: "archive_unreachable" },
    };
    const deps = api({ runBenchmark: vi.fn().mockResolvedValue(unreachable) });
    const { container } = render(<BenchmarkView api={deps} />);
    await selectEntryAndAlgo();
    fireEvent.click(await screen.findByRole("button", { name: /run benchmark/i }));

    await waitFor(() => expect(container.textContent).toContain("Couldn't reach far enough back for NSE:ZYDUSWELL right now."));
    expect(container.textContent).toContain("Try again in a bit.");
    expect(container.textContent).not.toContain("doesn't have enough trading history");
    expect(container.textContent).not.toContain("41");
    expect(screen.queryByText(/copy raw result/i)).toBeNull();
  });

  it("greys out a symbol for the current algorithm after it is proven to lack enough history, and re-enables it under a different algorithm", async () => {
    const insufficient: BenchmarkResult = {
      params: { symbol: "NSE:INFY", timeframe: "day", source: "bhavcopy", horizon: "positional", algoId: "kronos", lookaheadBars: 5, fromTs: 0, toTs: 0 },
      candles: [],
      decisionPoints: [],
      cancelled: false,
      insufficientHistory: { have: 8, need: 256, reason: "symbol_history" },
    };
    const deps = api({ runBenchmark: vi.fn().mockResolvedValue(insufficient) });
    render(<BenchmarkView api={deps} />);
    fireEvent.click(await screen.findByRole("button", { name: /NSE:INFY/ }));
    fireEvent.click(await screen.findByRole("button", { name: /^kronos/i }));
    fireEvent.click(await screen.findByRole("button", { name: /run benchmark/i }));
    await waitFor(() => expect(deps.runBenchmark).toHaveBeenCalledTimes(1));

    fireEvent.click(await screen.findByRole("button", { name: /run another test/i }));
    const option = await screen.findByRole("button", { name: /NSE:INFY/ });
    expect(option).toHaveProperty("disabled", true);
    expect(option.textContent).toMatch(/not enough history/i);

    fireEvent.click(option); // still clickable in the sense of re-selecting isn't needed; algo switch alone re-enables it
    fireEvent.click(await screen.findByRole("button", { name: /^sma/i }));
    const optionUnderSma = await screen.findByRole("button", { name: /NSE:INFY/ });
    expect(optionUnderSma).toHaveProperty("disabled", false);
  });

  it("does not grey out a symbol after a transient archive-unreachable result", async () => {
    const unreachable: BenchmarkResult = {
      params: { symbol: "NSE:INFY", timeframe: "day", source: "bhavcopy", horizon: "positional", algoId: "kronos", lookaheadBars: 5, fromTs: 0, toTs: 0 },
      candles: [],
      decisionPoints: [],
      cancelled: false,
      insufficientHistory: { have: 41, need: 256, reason: "archive_unreachable" },
    };
    const deps = api({ runBenchmark: vi.fn().mockResolvedValue(unreachable) });
    render(<BenchmarkView api={deps} />);
    await selectEntryAndAlgo();
    fireEvent.click(await screen.findByRole("button", { name: /run benchmark/i }));
    await waitFor(() => expect(deps.runBenchmark).toHaveBeenCalledTimes(1));

    fireEvent.click(await screen.findByRole("button", { name: /run another test/i }));
    const option = await screen.findByRole("button", { name: /NSE:INFY/ });
    expect(option).toHaveProperty("disabled", false);
  });

  it("shows the resolved test date after a successful run", async () => {
    const deps = api({ runBenchmark: vi.fn().mockResolvedValue(resultWith([])) });
    render(<BenchmarkView api={deps} />);
    await selectEntryAndAlgo();
    fireEvent.click(await screen.findByRole("button", { name: /run benchmark/i }));
    expect(await screen.findByText(/tested 2023-11-14/i)).toBeTruthy();
  });
});
