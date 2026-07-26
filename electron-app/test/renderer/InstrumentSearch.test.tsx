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

  it("submits the selected instrument and chosen horizon", async () => {
    installBridge({
      searchInstruments: vi.fn(async () => ({
        data: [{ tradingsymbol: "INFY", exchange: "NSE", segment: "NSE", instrument_token: 408065 }],
      })),
    });
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
    installBridge({
      searchInstruments: vi.fn(async () => {
        throw new Error("network down");
      }),
    });
    render(<InstrumentSearch onSubmit={vi.fn()} />);

    fireEvent.change(screen.getByLabelText(/instrument search/i), { target: { value: "infy" } });

    expect(await screen.findByText(/network down/)).toBeTruthy();
  });
});
