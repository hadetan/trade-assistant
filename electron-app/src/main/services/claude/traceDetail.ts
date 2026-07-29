export const TRACE_DETAIL_MAX = 200;

export function summarizeForTrace(text: string, max = TRACE_DETAIL_MAX): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max)}… (truncated, ${collapsed.length} chars)`;
}
