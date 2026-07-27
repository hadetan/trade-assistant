// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { sanitizeSvg } from "../../src/renderer/mermaid";

describe("sanitizeSvg", () => {
  it("keeps SVG shape but strips script, style and event handlers", () => {
    const dirty =
      '<svg xmlns="http://www.w3.org/2000/svg"><style>.x{fill:red}</style>' +
      '<script>alert(1)</script><rect width="10" height="10" onload="alert(2)"/></svg>';
    const clean = sanitizeSvg(dirty);
    expect(clean).toContain("<svg");
    expect(clean).toContain("<rect");
    expect(clean).not.toMatch(/<script/i);
    expect(clean).not.toMatch(/<style/i);
    expect(clean).not.toMatch(/on\w+\s*=/i);
  });
});
