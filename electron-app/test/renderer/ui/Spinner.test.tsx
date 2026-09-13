// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Spinner } from "../../../src/renderer/ui/Spinner";

afterEach(cleanup);

describe("Spinner", () => {
  it("renders with an accessible status role and default label", () => {
    render(<Spinner />);
    expect(screen.getByRole("status", { name: "Loading" })).toBeTruthy();
  });

  it("accepts a custom label and size", () => {
    render(<Spinner label="Running…" size={24} />);
    const el = screen.getByRole("status", { name: "Running…" });
    expect(el.getAttribute("width")).toBe("24");
  });
});
