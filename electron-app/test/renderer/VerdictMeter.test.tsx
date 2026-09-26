// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { VerdictMeter } from "../../src/renderer/VerdictMeter";

afterEach(cleanup);

describe("VerdictMeter", () => {
  it("renders no text content at all -- direction/magnitude are visual only", () => {
    const { container } = render(<VerdictMeter weightedVote={0.62} />);
    expect(container.textContent).toBe("");
  });

  it("extends the fill to the right (bullish side) for a positive vote, sized to its magnitude", () => {
    const { container } = render(<VerdictMeter weightedVote={0.5} />);
    const fill = container.querySelector(".verdict-meter-fill") as HTMLElement;
    expect(fill.dataset.direction).toBe("bullish");
    expect(fill.style.width).toBe("25%"); // 0.5 * 50% half-track
  });

  it("extends the fill to the left (bearish side) for a negative vote", () => {
    const { container } = render(<VerdictMeter weightedVote={-0.3} />);
    const fill = container.querySelector(".verdict-meter-fill") as HTMLElement;
    expect(fill.dataset.direction).toBe("bearish");
    expect(fill.style.width).toBe("15%"); // 0.3 * 50%
  });

  it("renders a neutral (zero-width) fill at exactly zero", () => {
    const { container } = render(<VerdictMeter weightedVote={0} />);
    const fill = container.querySelector(".verdict-meter-fill") as HTMLElement;
    expect(fill.style.width).toBe("0%");
  });

  it("clamps a vote outside [-1, 1] to the track's full half-width", () => {
    const { container } = render(<VerdictMeter weightedVote={1.4} />);
    const fill = container.querySelector(".verdict-meter-fill") as HTMLElement;
    expect(fill.style.width).toBe("50%");
  });
});
