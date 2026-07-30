// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModePicker } from "../../src/renderer/ModePicker";

afterEach(cleanup);

describe("ModePicker", () => {
  it("offers both modes and reports the chosen one", () => {
    const onSelect = vi.fn();
    render(<ModePicker onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: /ai-assisted/i }));
    expect(onSelect).toHaveBeenCalledWith("ai_assisted");
    fireEvent.click(screen.getByRole("button", { name: /engine-only/i }));
    expect(onSelect).toHaveBeenCalledWith("engine_only");
  });

  it("shows an icon on each card", () => {
    const { container } = render(<ModePicker onSelect={vi.fn()} />);
    expect(container.querySelectorAll(".mode-card-icon")).toHaveLength(2);
  });

  it("selects a card via the keyboard (Enter) as well as a click", () => {
    const onSelect = vi.fn();
    render(<ModePicker onSelect={onSelect} />);
    fireEvent.keyDown(screen.getByRole("button", { name: /engine-only/i }), { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("engine_only");
  });
});
