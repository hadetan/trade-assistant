// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TextField } from "../../../src/renderer/ui/TextField";

afterEach(cleanup);

describe("TextField", () => {
  it("renders a plain input by default with no search icon", () => {
    const { container } = render(<TextField aria-label="plain" value="" onChange={() => {}} />);
    expect(screen.getByLabelText("plain")).toBeTruthy();
    expect(container.querySelector(".text-field-icon")).toBeNull();
  });

  it("renders a search icon when variant is search", () => {
    const { container } = render(<TextField variant="search" aria-label="search" value="" onChange={() => {}} />);
    expect(container.querySelector(".text-field-icon")).toBeTruthy();
  });

  it("forwards value/onChange/placeholder/type to the underlying input", () => {
    const onChange = vi.fn();
    render(<TextField aria-label="qty" type="number" placeholder="Qty" value="5" onChange={onChange} />);
    const input = screen.getByLabelText("qty") as HTMLInputElement;
    expect(input.type).toBe("number");
    expect(input.placeholder).toBe("Qty");
    expect(input.value).toBe("5");
    fireEvent.change(input, { target: { value: "6" } });
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
