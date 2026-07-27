// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageMarkdown } from "../../src/renderer/MessageMarkdown";

vi.mock("../../src/renderer/mermaid", () => ({
  initMermaid: vi.fn(),
  sanitizeSvg: (s: string) => s,
  renderMermaid: vi.fn(async () => "<svg data-testid='diagram'></svg>"),
}));

afterEach(cleanup);

describe("MessageMarkdown", () => {
  it("renders sanitized markdown text", () => {
    render(<MessageMarkdown text="Overall read: **bullish**." />);
    expect(screen.getByText(/Overall read:/)).toBeTruthy();
  });

  it("replaces a mermaid fence with the sanitized diagram svg", async () => {
    render(<MessageMarkdown text={"```mermaid\nflowchart TD\nA-->B\n```\n"} />);
    expect(await screen.findByTestId("diagram")).toBeTruthy();
  });

  it("does not execute an injected handler", () => {
    const { container } = render(<MessageMarkdown text={'<img src=x onerror="alert(1)">'} />);
    expect(container.innerHTML).not.toMatch(/onerror/i);
  });
});
