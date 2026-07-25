// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InstrumentSearch, parseInstruments } from "../../src/renderer/InstrumentSearch";

afterEach(cleanup);

function installBridge(searchImpl: (q: string) => Promise<unknown>) {
  (window as unknown as { tradeAssistant: unknown }).tradeAssistant = {
    getStatus: vi.fn(),
    onBanner: vi.fn(),
    login: vi.fn(),
    searchInstruments: vi.fn(searchImpl),
    runAnalysis: vi.fn(),
  };
}

describe("parseInstruments", () => {
  it("maps the Kite search payload to InstrumentSelection[]", () => {
    const parsed = parseInstruments({
      data: [{ tradingsymbol: "INFY", exchange: "NSE", segment: "NSE", instrument_token: 408065 }],
    });
    expect(parsed).toEqual([{ symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", instrumentToken: "408065" }]);
  });

  it("returns [] for an unrecognized payload", () => {
    expect(parseInstruments({ nope: true })).toEqual([]);
  });
});

describe("InstrumentSearch", () => {
  it("debounces the query and lists results", async () => {
    installBridge(async () => ({
      data: [{ tradingsymbol: "INFY", exchange: "NSE", segment: "NSE", instrument_token: 408065 }],
    }));
    render(<InstrumentSearch onSubmit={vi.fn()} />);

    fireEvent.change(screen.getByLabelText(/instrument search/i), { target: { value: "infy" } });
    expect(await screen.findByRole("button", { name: "NSE:INFY" })).toBeTruthy();
  });

  it("submits the selected instrument and chosen horizon", async () => {
    installBridge(async () => ({
      data: [{ tradingsymbol: "INFY", exchange: "NSE", segment: "NSE", instrument_token: 408065 }],
    }));
    const onSubmit = vi.fn();
    render(<InstrumentSearch onSubmit={onSubmit} />);

    fireEvent.change(screen.getByLabelText(/instrument search/i), { target: { value: "infy" } });
    fireEvent.click(await screen.findByRole("button", { name: "NSE:INFY" }));
    fireEvent.click(screen.getByLabelText(/positional/i));
    fireEvent.click(screen.getByRole("button", { name: /analyze/i }));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", instrumentToken: "408065" },
        "positional",
      ),
    );
  });

  it("shows an error message when the search fails instead of failing silently", async () => {
    installBridge(async () => {
      throw new Error("network down");
    });
    render(<InstrumentSearch onSubmit={vi.fn()} />);

    fireEvent.change(screen.getByLabelText(/instrument search/i), { target: { value: "infy" } });

    expect(await screen.findByText(/network down/)).toBeTruthy();
  });
});
