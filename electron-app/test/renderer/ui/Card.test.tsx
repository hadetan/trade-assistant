// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Card } from "../../../src/renderer/ui/Card";

afterEach(cleanup);

describe("Card", () => {
  it("renders its children inside a div with the base card class", () => {
    render(<Card>content</Card>);
    const card = screen.getByText("content");
    expect(card.className).toContain("card");
    expect(card.className).not.toContain("card-interactive");
  });

  it("adds the interactive class when interactive is true", () => {
    render(<Card interactive>content</Card>);
    expect(screen.getByText("content").className).toContain("card-interactive");
  });

  it("forwards arbitrary HTML attributes (role, onClick, className)", () => {
    render(
      <Card role="button" className="mode-card" tabIndex={0}>
        content
      </Card>,
    );
    const card = screen.getByRole("button");
    expect(card.className).toContain("mode-card");
    expect(card.tabIndex).toBe(0);
  });
});
