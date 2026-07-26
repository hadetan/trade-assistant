import mermaid from "mermaid";
import DOMPurify from "dompurify";

let initialized = false;

export function initMermaid(): void {
  if (initialized) return;
  mermaid.initialize({ startOnLoad: false, securityLevel: "strict", htmlLabels: false, theme: "neutral" });
  initialized = true;
}

// Strip Mermaid's injected <style> (blocked by style-src 'self'); the diagram
// theme is shipped as static .mermaid svg rules in style.css instead.
export function sanitizeSvg(svg: string): string {
  return DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ["style", "script"],
    FORBID_ATTR: ["style"],
  });
}

export async function renderMermaid(source: string, id: string): Promise<string> {
  initMermaid();
  const { svg } = await mermaid.render(id, source);
  return sanitizeSvg(svg);
}
