import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styleCss = readFileSync("src/renderer/style.css", "utf8");
const chatViewCss = readFileSync("src/renderer/ChatView.css", "utf8");

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
