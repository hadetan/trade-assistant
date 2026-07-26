import { describe, expect, it } from "vitest";
import { handleKiteResponse } from "../../src/main/bootstrap";
import { KiteSessionState } from "../../src/main/services/kite/kiteSessionState";

describe("handleKiteResponse", () => {
  it("marks the session as needing login when the resolved response is login-gate-shaped", () => {
    const sessionState = new KiteSessionState();
    sessionState.markAuthenticated();

    handleKiteResponse(sessionState, {
      content: [{ type: "text", text: "Please login to Kite first to continue." }],
    });

    expect(sessionState.status).toBe("needsLogin");
  });

  it("leaves an authenticated session untouched on an ordinary successful response", () => {
    const sessionState = new KiteSessionState();
    sessionState.markAuthenticated();

    handleKiteResponse(sessionState, {
      content: [{ type: "text", text: JSON.stringify([{ instrument_token: 408065, tradingsymbol: "INFY" }]) }],
    });

    expect(sessionState.status).toBe("authenticated");
  });
});
