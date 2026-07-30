import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styleCss = readFileSync("src/renderer/style.css", "utf8");
const chatViewCss = readFileSync("src/renderer/ChatView.css", "utf8");
const tokensCss = readFileSync("src/renderer/ui/tokens.css", "utf8");

describe("style.css / ChatView.css split", () => {
  it("keeps shared rules in style.css", () => {
    expect(styleCss).toMatch(/\.error\s*{/);
    expect(styleCss).toMatch(/\.message-markdown/);
    expect(styleCss).toMatch(/\.mermaid/);
  });

  it("does not add chat-specific rules to style.css", () => {
    expect(styleCss).not.toMatch(/\.chat-view/);
    expect(styleCss).not.toMatch(/\.messages\s*{/);
    expect(styleCss).not.toMatch(/\.chat-input/);
    expect(styleCss).not.toMatch(/\.verdict/);
  });

  it("puts the new chat rules in ChatView.css instead", () => {
    expect(chatViewCss).toMatch(/\.chat-view\s*{/);
    expect(chatViewCss).toMatch(/\.messages\s*{/);
    expect(chatViewCss).toMatch(/\.chat-input/);
    expect(chatViewCss).toMatch(/\.verdict/);
  });
});

describe("tokens.css purity", () => {
  it("declares the dark-default and light-override token blocks", () => {
    expect(tokensCss).toMatch(/:root\s*{/);
    expect(tokensCss).toMatch(/\[data-theme=["']light["']\]\s*{/);
  });

  it("contains only custom-property declarations, no component selectors", () => {
    // Strip the two allowed block selectors and their braces; whatever's left
    // between the remaining `{`/`}` pairs must be pure `--x: value;` lines.
    const withoutBlockSelectors = tokensCss
      .replace(/:root\s*{/g, "{")
      .replace(/\[data-theme=["']light["']\]\s*{/g, "{");
    const declarationLines = withoutBlockSelectors
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && line !== "{" && line !== "}" && !line.startsWith("/*") && !line.startsWith("*"));
    for (const line of declarationLines) {
      expect(line).toMatch(/^--[a-z0-9-]+:\s*.+;$/);
    }
    expect(tokensCss).not.toMatch(/\.button\b/);
    expect(tokensCss).not.toMatch(/\.card\b/);
  });
});
