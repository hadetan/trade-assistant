import { describe, expect, it, vi } from "vitest";
import { createKiteTicker } from "../../../../src/main/services/kite/kiteTicker";
import type { KiteTickerLike } from "../../../../src/main/services/kite/kiteTicker";

function fakeTickerLike(): KiteTickerLike & { emit: (event: string, ...args: unknown[]) => void } {
  const handlers = new Map<string, ((...args: unknown[]) => void)[]>();
  return {
    modeLTP: "ltp",
    modeQuote: "quote",
    modeFull: "full",
    api_key: "",
    access_token: "",
    connect: vi.fn(),
    disconnect: vi.fn(),
    connected: vi.fn().mockReturnValue(false),
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

  it("updateCredentialsAndConnect() sets api_key/access_token on the underlying ticker then calls connect()", () => {
    const fake = fakeTickerLike();
    const client = createKiteTicker("k", "a", { createTicker: () => fake });

    client.updateCredentialsAndConnect("k2", "at2");

    expect(fake.api_key).toBe("k2");
    expect(fake.access_token).toBe("at2");
    expect(fake.connect).toHaveBeenCalledTimes(1);
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

  it("onTick's returned unsubscribe stops only that handler; others keep firing", () => {
    const fake = fakeTickerLike();
    const client = createKiteTicker("k", "a", { createTicker: () => fake });
    const first: unknown[] = [];
    const second: unknown[] = [];
    const unsubscribeFirst = client.onTick((ticks) => first.push(ticks));
    client.onTick((ticks) => second.push(ticks));

    fake.emit("ticks", [{ last_price: 1 }]);
    unsubscribeFirst();
    fake.emit("ticks", [{ last_price: 2 }]);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(2);
  });

  it("onConnectionChange's returned unsubscribe stops only that handler; others keep firing", () => {
    const fake = fakeTickerLike();
    const client = createKiteTicker("k", "a", { createTicker: () => fake });
    const first: string[] = [];
    const second: string[] = [];
    const unsubscribeFirst = client.onConnectionChange((status) => first.push(status));
    client.onConnectionChange((status) => second.push(status));

    fake.emit("connect");
    unsubscribeFirst();
    fake.emit("reconnect");

    expect(first).toEqual(["connected"]);
    expect(second).toEqual(["connected", "reconnecting"]);
  });

  it("a handler that unsubscribes itself mid-dispatch does not skip the next handler", () => {
    const fake = fakeTickerLike();
    const client = createKiteTicker("k", "a", { createTicker: () => fake });
    const seen: string[] = [];
    const unsubscribeSelf = client.onConnectionChange(() => {
      seen.push("first");
      unsubscribeSelf();
    });
    client.onConnectionChange(() => seen.push("second"));

    fake.emit("connect");

    expect(seen).toEqual(["first", "second"]);
  });
});
