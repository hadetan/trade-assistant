// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button } from "../../../src/renderer/ui/Button";

afterEach(cleanup);

describe("Button", () => {
  it("defaults to the primary variant and md size", () => {
    render(<Button>Go</Button>);
    const button = screen.getByRole("button", { name: "Go" });
    expect(button.className).toContain("btn-primary");
    expect(button.className).toContain("btn-md");
  });

  it("applies every documented variant class", () => {
    (["primary", "secondary", "ghost", "danger"] as const).forEach((variant) => {
      const { unmount } = render(<Button variant={variant}>x</Button>);
      expect(screen.getByRole("button").className).toContain(`btn-${variant}`);
      unmount();
    });
  });

  it("applies every documented size class", () => {
    (["sm", "md"] as const).forEach((size) => {
      const { unmount } = render(<Button size={size}>x</Button>);
      expect(screen.getByRole("button").className).toContain(`btn-${size}`);
      unmount();
    });
  });

  it("defaults type to button so it never submits an ancestor form by accident", () => {
    render(<Button>Go</Button>);
    expect(screen.getByRole("button").getAttribute("type")).toBe("button");
  });

  it("forwards an explicit type, onClick, and disabled", () => {
    const onClick = vi.fn();
    render(
      <Button type="submit" onClick={onClick} disabled>
        Go
      </Button>,
    );
    const button = screen.getByRole("button") as HTMLButtonElement;
    expect(button.type).toBe("submit");
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled(); // native disabled semantics suppress the click
  });
});
