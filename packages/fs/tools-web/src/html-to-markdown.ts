/**
 * HTML-to-Markdown conversion — preserves headings, links, lists, bold/italic.
 *
 * Zero external dependencies. Handles common HTML patterns; not a full spec implementation.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Decode common HTML entities. */
function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
    .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Convert HTML to Markdown, preserving structure (headings, links, lists, emphasis).
 *
 * - Removes <script>, <style>, <noscript> blocks entirely
 * - Converts <h1>-<h6> to # headings
 * - Converts <a href> to [text](url) links
 * - Converts <strong>/<b> to **bold** and <em>/<i> to *italic*
 * - Converts <li> to bullet points
 * - Converts <code> to `inline code`
 * - Converts <pre> to fenced code blocks
 * - Converts <blockquote> to > prefixed lines
 * - Converts <hr> to ---
 * - Decodes HTML entities
 * - Collapses excessive whitespace
 */
export function htmlToMarkdown(html: string): string {
  // Remove script, style, noscript blocks
  // justified: let — must be reassigned in sequential transformations
  let text = html.replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, "");

  // Convert headings
  text = text.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level, content) => {
    const prefix = "#".repeat(parseInt(level, 10));
    return `\n${prefix} ${cleanInline(content)}\n`;
  });

  // Convert links: <a href="url">text</a> → [text](url)
  text = text.replace(/<a\s+[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href, content) => {
    const linkText = cleanInline(content);
    return `[${linkText}](${href})`;
  });

  // Convert bold
  text = text.replace(/<(?:strong|b)[^>]*>([\s\S]*?)<\/(?:strong|b)>/gi, (_m, content) => {
    return `**${cleanInline(content)}**`;
  });

  // Convert italic
  text = text.replace(/<(?:em|i)[^>]*>([\s\S]*?)<\/(?:em|i)>/gi, (_m, content) => {
    return `*${cleanInline(content)}*`;
  });

  // Convert inline code
  text = text.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_m, content) => {
    return `\`${cleanInline(content)}\``;
  });

  // Convert pre blocks to fenced code blocks
  text = text.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_m, content) => {
    const code = cleanInline(content).trim();
    return `\n\`\`\`\n${code}\n\`\`\`\n`;
  });

  // Convert blockquotes
  text = text.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_m, content) => {
    const lines = cleanInline(content).trim().split("\n");
    return `\n${lines.map((l) => `> ${l}`).join("\n")}\n`;
  });

  // Convert list items
  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, content) => {
    return `\n- ${cleanInline(content).trim()}`;
  });

  // Convert <hr> to ---
  text = text.replace(/<hr[^>]*\/?>/gi, "\n---\n");

  // Convert <br> to newlines
  text = text.replace(/<br[^>]*\/?>/gi, "\n");

  // Insert newlines for remaining block elements
  text = text.replace(
    /<\/?(?:p|div|tr|section|article|header|footer|nav|main|aside|ul|ol|table)[^>]*>/gi,
    "\n",
  );

  // Remove remaining HTML tags
  text = text.replace(/<[^>]+>/g, "");

  // Decode entities
  text = decodeEntities(text);

  // Collapse whitespace
  text = text
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return text;
}

/** Strip tags from inline content (for use inside markdown constructs). */
function cleanInline(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
