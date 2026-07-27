// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IntentLensSelector } from "../../src/renderer/IntentLensSelector";

afterEach(cleanup);

describe("IntentLensSelector", () => {
  it("reflects the current value and reports changes", () => {
    const onChange = vi.fn();
    render(<IntentLensSelector value="buying" onChange={onChange} />);
    expect((screen.getByLabelText(/buying/i) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByLabelText(/selling/i));
    expect(onChange).toHaveBeenCalledWith("selling");
  });
});
