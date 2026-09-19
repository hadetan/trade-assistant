// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InstrumentSearch, parseInstruments } from "../../src/renderer/InstrumentSearch";
import { installBridge } from "./testBridge";

afterEach(cleanup);

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

  it("unwraps an MCP CallToolResult content-array response", () => {
    const parsed = parseInstruments({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            data: [{ tradingsymbol: "INFY", exchange: "NSE", segment: "NSE", instrument_token: 408065 }],
          }),
        },
      ],
    });
    expect(parsed).toEqual([{ symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", instrumentToken: "408065" }]);
  });

  it("drops a row missing instrument_token instead of returning an empty selectable instrument", () => {
    const parsed = parseInstruments({
      data: [{ tradingsymbol: "INFY", exchange: "NSE", segment: "NSE" }],
    });
    expect(parsed).toEqual([]);
  });

  it("ignores a null entry in the response array instead of throwing", () => {
    expect(() =>
      parseInstruments({
        data: [null, { tradingsymbol: "INFY", exchange: "NSE", segment: "NSE", instrument_token: 408065 }],
      }),
    ).not.toThrow();
  });
});

describe("InstrumentSearch", () => {
  it("debounces the query and lists results", async () => {
    installBridge({
      searchInstruments: vi.fn(async () => ({
        data: [{ tradingsymbol: "INFY", exchange: "NSE", segment: "NSE", instrument_token: 408065 }],
      })),
    });
    render(<InstrumentSearch onSubmit={vi.fn()} />);

    fireEvent.change(screen.getByLabelText(/instrument search/i), { target: { value: "infy" } });
    expect(await screen.findByRole("button", { name: "NSE:INFY" })).toBeTruthy();
  });

  it("submits the selected instrument and chosen candle interval", async () => {
    installBridge({
      searchInstruments: vi.fn(async () => ({
        data: [{ tradingsymbol: "INFY", exchange: "NSE", segment: "NSE", instrument_token: 408065 }],
      })),
    });
    const onSubmit = vi.fn();
    render(<InstrumentSearch onSubmit={onSubmit} />);

    fireEvent.change(screen.getByLabelText(/instrument search/i), { target: { value: "infy" } });
    fireEvent.click(await screen.findByRole("button", { name: "NSE:INFY" }));
    fireEvent.click(screen.getByRole("button", { name: /15-minute/i }));
    fireEvent.click(screen.getByRole("button", { name: /analyze/i }));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        { symbol: "NSE:INFY", exchange: "NSE", segment: "NSE", instrumentToken: "408065" },
        "15minute",
      ),
    );
  });

  it("offers exactly the three intraday intervals and no Horizon choice at all", () => {
    installBridge();
    render(<InstrumentSearch onSubmit={vi.fn()} />);

    expect(screen.getByRole("group", { name: /candle interval/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^5-minute$/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /10-minute/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /15-minute/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /positional/i })).toBeNull();
    expect(screen.queryByRole("group", { name: /horizon/i })).toBeNull();
  });

  it("defaults to the 5-minute interval", () => {
    installBridge();
    render(<InstrumentSearch onSubmit={vi.fn()} />);
    expect(screen.getByRole("button", { name: /^5-minute$/i })).toHaveProperty("ariaPressed", "true");
  });

  it("shows an error banner when the search fails instead of failing silently", async () => {
    installBridge({
      searchInstruments: vi.fn(async () => {
        throw new Error("network down");
      }),
    });
    render(<InstrumentSearch onSubmit={vi.fn()} />);

    fireEvent.change(screen.getByLabelText(/instrument search/i), { target: { value: "infy" } });

    expect(await screen.findByText(/network down/)).toBeTruthy();
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("clears the search-error banner once the query is shortened back below two characters", async () => {
    installBridge({
      searchInstruments: vi.fn(async () => {
        throw new Error("network down");
      }),
    });
    render(<InstrumentSearch onSubmit={vi.fn()} />);

    fireEvent.change(screen.getByLabelText(/instrument search/i), { target: { value: "infy" } });
    expect(await screen.findByText(/network down/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/instrument search/i), { target: { value: "i" } });
    await waitFor(() => expect(screen.queryByText(/network down/)).toBeNull());
  });

  it("swallows a rejected onSubmit instead of letting it escape as an unhandled rejection", async () => {
    installBridge({
      searchInstruments: vi.fn(async () => ({
        data: [{ tradingsymbol: "INFY", exchange: "NSE", segment: "NSE", instrument_token: 408065 }],
      })),
    });
    const onSubmit = vi.fn().mockRejectedValue(new Error("run failed"));
    render(<InstrumentSearch onSubmit={onSubmit} />);

    fireEvent.change(screen.getByLabelText(/instrument search/i), { target: { value: "infy" } });
    fireEvent.click(await screen.findByRole("button", { name: "NSE:INFY" }));
    fireEvent.click(screen.getByRole("button", { name: /analyze/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /analyze/i })).toHaveProperty("disabled", false),
    );
  });

  it("disables Analyze and shows a spinner while the submit promise is in flight, then re-enables it", async () => {
    installBridge({
      searchInstruments: vi.fn(async () => ({
        data: [{ tradingsymbol: "INFY", exchange: "NSE", segment: "NSE", instrument_token: 408065 }],
      })),
    });
    let resolveSubmit: () => void = () => {};
    const onSubmit = vi.fn(() => new Promise<void>((resolve) => { resolveSubmit = resolve; }));
    render(<InstrumentSearch onSubmit={onSubmit} />);

    fireEvent.change(screen.getByLabelText(/instrument search/i), { target: { value: "infy" } });
    fireEvent.click(await screen.findByRole("button", { name: "NSE:INFY" }));
    fireEvent.click(screen.getByRole("button", { name: /analyze/i }));

    expect(screen.getByRole("button", { name: /analyze/i })).toHaveProperty("disabled", true);
    resolveSubmit();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /analyze/i })).toHaveProperty("disabled", false),
    );
  });
});
