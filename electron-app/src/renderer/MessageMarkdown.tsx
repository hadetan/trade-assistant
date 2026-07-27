import { useEffect, useRef } from "react";
import { renderMarkdown } from "./markdown";
import { renderMermaid } from "./mermaid";

export interface MessageMarkdownProps {
  text: string;
}

export function MessageMarkdown({ text }: MessageMarkdownProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = ref.current;
    if (!container) return;
    container.innerHTML = renderMarkdown(text);
    const blocks = Array.from(container.querySelectorAll("code.language-mermaid"));
    blocks.forEach((block, index) => {
      const source = block.textContent ?? "";
      void renderMermaid(source, `mermaid-${index}-${Math.random().toString(36).slice(2)}`)
        .then((svg) => {
          const wrapper = document.createElement("div");
          wrapper.className = "mermaid";
          wrapper.innerHTML = svg;
          block.closest("pre")?.replaceWith(wrapper);
        })
        .catch(() => {
          // Leave the entity-escaped source visible if the diagram fails to parse.
        });
    });
  }, [text]);

  return <div className="message-markdown" ref={ref} />;
}
