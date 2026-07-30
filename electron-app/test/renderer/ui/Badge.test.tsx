// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Badge, directionTone } from "../../../src/renderer/ui/Badge";

afterEach(cleanup);

describe("Badge", () => {
  it("applies the tone-specific class for every documented tone", () => {
    (["bullish", "bearish", "neutral", "running", "done", "error"] as const).forEach((tone) => {
      const { unmount } = render(<Badge tone={tone}>x</Badge>);
      expect(screen.getByText("x").className).toContain(`badge-${tone}`);
      unmount();
    });
  });

  it("renders no remove button when onRemove is not supplied", () => {
    render(<Badge tone="neutral">NSE:INFY</Badge>);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders a labelled remove button and calls onRemove when clicked", () => {
    const onRemove = vi.fn();
    render(
      <Badge tone="neutral" onRemove={onRemove} removeLabel="Remove NSE:INFY">
        NSE:INFY
      </Badge>,
    );
    const button = screen.getByRole("button", { name: "Remove NSE:INFY" });
    fireEvent.click(button);
    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});

describe("directionTone", () => {
  it("maps bullish/bearish through and anything else to neutral", () => {
    expect(directionTone("bullish")).toBe("bullish");
    expect(directionTone("bearish")).toBe("bearish");
    expect(directionTone("neutral")).toBe("neutral");
    expect(directionTone("whatever")).toBe("neutral");
  });
});
