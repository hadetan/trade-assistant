// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmptyState } from "../../../src/renderer/ui/EmptyState";
import { Inbox } from "../../../src/renderer/ui/icons";

afterEach(cleanup);

describe("EmptyState", () => {
  it("renders the icon and message with no action button by default", () => {
    const { container } = render(<EmptyState icon={Inbox} message="No sessions yet — start a new one." />);
    expect(screen.getByText("No sessions yet — start a new one.")).toBeTruthy();
    expect(container.querySelector(".empty-state-icon")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders an action button and calls its onClick when supplied", () => {
    const onClick = vi.fn();
    render(<EmptyState icon={Inbox} message="Nothing here" action={{ label: "Start", onClick }} />);
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
