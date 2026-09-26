import { describe, expect, it, vi } from "vitest";
import { createKiteTicker } from "../../../../src/main/services/kite/kiteTicker";
import type { KiteTickerLike } from "../../../../src/main/services/kite/kiteTicker";

function fakeTickerLike(): KiteTickerLike & { emit: (event: string, ...args: unknown[]) => void } {
  const handlers = new Map<string, ((...args: unknown[]) => void)[]>();
  return {
    modeLTP: "ltp",
    modeQuote: "quote",
    modeFull: "full",
    connect: vi.fn(),
    disconnect: vi.fn(),
    subscribe: vi.fn(),
    setMode: vi.fn(),
    autoReconnect: vi.fn(),
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      const list = handlers.get(event) ?? [];
      list.push(cb);
      handlers.set(event, list);
    }),
    emit: (event: string, ...args: unknown[]) => {
      (handlers.get(event) ?? []).forEach((cb) => cb(...args));
    },
  };
}

describe("createKiteTicker", () => {
  it("constructs with api_key/access_token and enables auto-reconnect with the library's max retry count", () => {
    const fake = fakeTickerLike();
    const createTicker = vi.fn().mockReturnValue(fake);

    createKiteTicker("k123", "at999", { createTicker });

    expect(createTicker).toHaveBeenCalledWith({ api_key: "k123", access_token: "at999" });
    expect(fake.autoReconnect).toHaveBeenCalledWith(true, 300, 5);
  });

  it("connect() and disconnect() delegate to the underlying ticker", () => {
    const fake = fakeTickerLike();
    const client = createKiteTicker("k", "a", { createTicker: () => fake });

    client.connect();
    client.disconnect();

    expect(fake.connect).toHaveBeenCalledTimes(1);
    expect(fake.disconnect).toHaveBeenCalledTimes(1);
  });

  it("subscribe() calls subscribe then setMode with the resolved mode constant, defaulting to full", () => {
    const fake = fakeTickerLike();
    const client = createKiteTicker("k", "a", { createTicker: () => fake });

    client.subscribe([408065]);
    expect(fake.subscribe).toHaveBeenCalledWith([408065]);
    expect(fake.setMode).toHaveBeenCalledWith("full", [408065]);

    client.subscribe([408065], "ltp");
    expect(fake.setMode).toHaveBeenLastCalledWith("ltp", [408065]);
  });

  it("maps connect/reconnect/noreconnect/error events to onConnectionChange", () => {
    const fake = fakeTickerLike();
    const client = createKiteTicker("k", "a", { createTicker: () => fake });
    const statuses: string[] = [];
    client.onConnectionChange((status) => statuses.push(status));

    fake.emit("connect");
    fake.emit("reconnect");
    fake.emit("noreconnect");
    fake.emit("error", new Error("boom"));

    expect(statuses).toEqual(["connected", "reconnecting", "error", "error"]);
  });

  it("forwards the ticks payload to onTick handlers", () => {
    const fake = fakeTickerLike();
    const client = createKiteTicker("k", "a", { createTicker: () => fake });
    const received: unknown[] = [];
    client.onTick((ticks) => received.push(ticks));

    fake.emit("ticks", [{ instrument_token: 408065, last_price: 101.5 }]);

    expect(received).toEqual([[{ instrument_token: 408065, last_price: 101.5 }]]);
  });
});
