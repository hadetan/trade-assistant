// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../../src/renderer/markdown";

describe("renderMarkdown sanitization (DeepChat-class / mXSS)", () => {
  const payloads = [
    '<img src=x onerror="alert(1)">',
    "[click](javascript:alert(1))",
    '<a href="javascript:alert(1)">x</a>',
    '<svg onload="alert(1)"></svg>',
    "![img](data:text/html,<script>alert(1)</script>)",
    '<iframe src="evil"></iframe>',
    "<div><style>*{}</style></div>",
  ];

  for (const payload of payloads) {
    it(`neutralizes ${payload.slice(0, 24)}`, () => {
      const out = renderMarkdown(payload);
      expect(out).not.toMatch(/on\w+\s*=/i);
      expect(out).not.toMatch(/javascript:/i);
      expect(out).not.toMatch(/<script/i);
      expect(out).not.toMatch(/<iframe/i);
      expect(out).not.toMatch(/<style/i);
    });
  }
});

describe("renderMarkdown formatting", () => {
  it("renders tables, safe links, and mermaid fences as detectable output", () => {
    expect(renderMarkdown("| a | b |\n|---|---|\n| 1 | 2 |")).toContain("<table>");
    const link = renderMarkdown("[k](https://kite.zerodha.com)");
    expect(link).toContain('href="https://kite.zerodha.com"');
    expect(renderMarkdown("```mermaid\nflowchart TD\nA-->B\n```\n")).toContain('class="language-mermaid"');
  });
});

describe("renderMarkdown allowlist enforcement (not a denylist)", () => {
  it("neutralizes a nested-tag mutation-XSS payload (noscript/title mXSS shape)", () => {
    const out = renderMarkdown('<noscript><p title="</noscript><img src=x onerror=alert(1)>">');
    expect(out).not.toMatch(/on\w+\s*=/i);
    expect(out).not.toMatch(/<img/i);
    expect(out).not.toMatch(/<noscript/i);
  });

  it("strips a disallowed tag entirely while keeping surrounding safe text", () => {
    const out = renderMarkdown('before <video src="x"></video> after');
    expect(out).not.toMatch(/<video/i);
    expect(out).toContain("before");
    expect(out).toContain("after");
  });

  it("strips a disallowed attribute from an allowed tag while keeping the tag's content", () => {
    const out = renderMarkdown('<p onclick="alert(1)">hello</p>');
    expect(out).not.toMatch(/onclick/i);
    expect(out).toContain("hello");
  });

  it("still renders ordinary formatting untouched by the allowlist", () => {
    expect(renderMarkdown("**bold** and *em*")).toBe("<p><strong>bold</strong> and <em>em</em></p>\n");
  });
});
