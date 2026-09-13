// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { StatusDot } from "../../../src/renderer/ui/StatusDot";

afterEach(cleanup);

describe("StatusDot", () => {
  it("renders the label and a tone-specific wrapper class for every documented tone", () => {
    (["running", "done", "error"] as const).forEach((tone) => {
      const { unmount, container } = render(<StatusDot tone={tone} label={`state ${tone}`} />);
      expect(screen.getByText(`state ${tone}`)).toBeTruthy();
      expect(container.querySelector(`.status-dot-${tone}`)).toBeTruthy();
      unmount();
    });
  });

  it("spins only the running icon", () => {
    const { container: running } = render(<StatusDot tone="running" label="x" />);
    expect(running.querySelector(".status-dot-icon-spin")).toBeTruthy();
    const { container: done } = render(<StatusDot tone="done" label="x" />);
    expect(done.querySelector(".status-dot-icon-spin")).toBeNull();
  });

  it("forwards an extra className alongside the tone class", () => {
    const { container } = render(<StatusDot tone="done" label="x" className="sidebar-footer-row" />);
    const el = container.querySelector(".status-dot") as HTMLElement;
    expect(el.className).toContain("sidebar-footer-row");
  });
});
