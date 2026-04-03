/**
 * Minimal HTML-to-text extraction. Zero external dependencies.
 */

const ENTITIES: Readonly<Record<string, string>> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

export function stripHtml(html: string): string {
  // justified: let — must be reassigned in sequential transformations
  let text = html.replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, "");
  text = text.replace(
    /<\/?(?:p|div|br|h[1-6]|li|tr|blockquote|hr|section|article|header|footer|nav|main|aside|pre)[^>]*>/gi,
    "\n",
  );
  text = text.replace(/<[^>]+>/g, "");
  text = text.replace(/&(?:#\d+|#x[\da-f]+|\w+);/gi, (entity) => {
    const lower = entity.toLowerCase();
    const named = ENTITIES[lower];
    if (named !== undefined) return named;
    if (lower.startsWith("&#x")) {
      const code = parseInt(lower.slice(3, -1), 16);
      return Number.isNaN(code) ? entity : String.fromCharCode(code);
    }
    if (lower.startsWith("&#")) {
      const code = parseInt(lower.slice(2, -1), 10);
      return Number.isNaN(code) ? entity : String.fromCharCode(code);
    }
    return entity;
  });
  text = text
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line, i, arr) => !(line === "" && i > 0 && arr[i - 1] === ""))
    .join("\n")
    .trim();
  return text;
}
