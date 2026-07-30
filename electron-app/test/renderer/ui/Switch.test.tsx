// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Switch } from "../../../src/renderer/ui/Switch";

afterEach(cleanup);

describe("Switch", () => {
  it("reflects the checked prop and exposes a switch role via its label", () => {
    render(<Switch checked={true} onChange={vi.fn()} label="Enable proactive scanning" />);
    const input = screen.getByLabelText("Enable proactive scanning") as HTMLInputElement;
    expect(input.checked).toBe(true);
    expect(input.getAttribute("role")).toBe("switch");
  });

  it("calls onChange with the flipped boolean when toggled", () => {
    const onChange = vi.fn();
    render(<Switch checked={false} onChange={onChange} label="Enable proactive scanning" />);
    fireEvent.click(screen.getByLabelText("Enable proactive scanning"));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("disables the input when disabled is true", () => {
    render(<Switch checked={false} onChange={vi.fn()} label="x" disabled />);
    expect((screen.getByLabelText("x") as HTMLInputElement).disabled).toBe(true);
  });
});
