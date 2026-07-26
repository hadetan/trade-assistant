import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";

// html:true so raw/malformed tags (the DeepChat-class `<img onerror>` shape) become real
// DOM nodes for DOMPurify to strip attributes/tags from below. With html:false, markdown-it
// itself HTML-escapes them into inert-looking text — safe, but the escaped source (e.g.
// `onerror="..."`) still reads back out of DOMPurify's re-serialized text node, since only
// `<`/`>`/`&` need escaping there, not `=`. DOMPurify is the one actually built to defend
// against real (possibly mutated) markup, so let it see real markup.
const md = new MarkdownIt({ html: true, linkify: true });
// Defer all protocol enforcement to DOMPurify's ALLOWED_URI_REGEXP below — markdown-it's
// own default validateLink would otherwise degrade a disallowed-protocol link into plain
// bracket-paren text (e.g. "[x](javascript:...)") instead of a real <a href>, leaving the
// raw scheme string sitting in text DOMPurify never touches because it isn't an attribute.
md.validateLink = () => true;

const ALLOWED_TAGS = [
  "p", "br", "hr", "blockquote", "pre", "code", "span",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "strong", "em", "del", "s", "b", "i",
  "ul", "ol", "li",
  "a", "img",
  "table", "thead", "tbody", "tr", "th", "td",
];
const ALLOWED_ATTR = ["href", "src", "alt", "title", "class"];
const ALLOWED_URI_REGEXP = /^(?:https?:|mailto:)/i;

export function renderMarkdown(text: string): string {
  const html = md.render(text);
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOWED_URI_REGEXP,
    FORBID_TAGS: ["style", "script", "iframe", "object", "embed", "form", "input"],
    FORBID_ATTR: ["style"],
  });
}
