/**
 * Minimal HTML-to-text extraction — strips tags, decodes common entities,
 * and collapses whitespace. Zero external dependencies.
 */

// ---------------------------------------------------------------------------
// Common HTML entity map
// ---------------------------------------------------------------------------

const ENTITIES: Readonly<Record<string, string>> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Strip HTML tags and convert to plain text.
 *
 * - Removes <script>, <style>, and <noscript> blocks entirely
 * - Inserts newlines for block-level elements (<p>, <div>, <br>, <h1-6>, <li>)
 * - Decodes common HTML entities
 * - Collapses runs of whitespace
 */
export function stripHtml(html: string): string {
  // Remove script, style, noscript blocks (including content)
  // justified: let — must be reassigned in sequential transformations
  let text = html.replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, "");

  // Insert newlines for block-level elements
  text = text.replace(
    /<\/?(?:p|div|br|h[1-6]|li|tr|blockquote|hr|section|article|header|footer|nav|main|aside|pre)[^>]*>/gi,
    "\n",
  );

  // Remove remaining HTML tags
  text = text.replace(/<[^>]+>/g, "");

  // Decode HTML entities
  text = text.replace(/&(?:#\d+|#x[\da-f]+|\w+);/gi, (entity) => {
    const lower = entity.toLowerCase();

    // Check named entities
    const named = ENTITIES[lower];
    if (named !== undefined) return named;

    // Numeric entity: &#123; or &#x7B;
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

  // Collapse whitespace: multiple blank lines → single, trim each line
  text = text
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line, i, arr) => {
      // Remove consecutive empty lines
      if (line === "" && i > 0 && arr[i - 1] === "") return false;
      return true;
    })
    .join("\n")
    .trim();

  return text;
}
