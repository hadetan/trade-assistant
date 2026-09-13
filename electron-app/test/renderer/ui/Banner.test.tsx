// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Banner } from "../../../src/renderer/ui/Banner";

afterEach(cleanup);

describe("Banner", () => {
  it("renders its message and a variant-specific class for every documented variant", () => {
    (["info", "warning", "error"] as const).forEach((variant) => {
      const { unmount, container } = render(<Banner variant={variant}>{variant} message</Banner>);
      expect(screen.getByText(`${variant} message`)).toBeTruthy();
      expect(container.querySelector(`.banner-${variant}`)).toBeTruthy();
      unmount();
    });
  });

  it("uses an alert role for the error variant so it is announced immediately", () => {
    render(<Banner variant="error">boom</Banner>);
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("uses a status role for info/warning so they don't interrupt", () => {
    render(<Banner variant="warning">heads up</Banner>);
    expect(screen.getByRole("status")).toBeTruthy();
  });
});
