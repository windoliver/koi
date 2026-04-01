/**
 * Text formatting for email HTML.
 *
 * Converts plain text to a minimal responsive HTML email template.
 */

/**
 * Converts plain text to a minimal HTML email body.
 *
 * Transforms:
 * - Newlines → `<br>` tags
 * - `**bold**` → `<strong>bold</strong>`
 * - `*italic*` → `<em>italic</em>`
 * - `[text](url)` → `<a href="url">text</a>`
 * - `` `code` `` → `<code>code</code>`
 * - Wraps in a responsive email template
 */
export function mapTextToHtml(plainText: string): string {
  // let justified: pipeline transformation
  let html = escapeHtml(plainText);

  // Code (before other transformations to avoid conflict)
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");

  // Links: [text](url) → <a href="url">text</a>
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" style="color:#1a73e8;">$1</a>');

  // Bold: **text** → <strong>text</strong>
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");

  // Italic: *text* → <em>text</em>
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");

  // Newlines to <br>
  html = html.replace(/\n/g, "<br>\n");

  return wrapTemplate(html);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function wrapTemplate(body: string): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:14px;line-height:1.5;color:#333;max-width:600px;margin:0 auto;padding:16px;">
${body}
</body>
</html>`;
}
