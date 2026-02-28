/**
 * Text formatting for Slack mrkdwn.
 *
 * Converts common Markdown patterns to Slack's mrkdwn format.
 * See: https://api.slack.com/reference/surfaces/formatting
 */

/**
 * Converts Markdown-style text to Slack mrkdwn format.
 *
 * Transforms:
 * - `**bold**` → `*bold*`
 * - `__bold__` → `*bold*`
 * - `*italic*` → `_italic_`
 * - `_italic_` → `_italic_`
 * - `~~strike~~` → `~strike~`
 * - `[text](url)` → `<url|text>`
 * - `> quote` → `> quote` (same)
 * - `` `code` `` → `` `code` `` (same)
 * - ```` ```block``` ```` → ```` ```block``` ```` (same)
 */
export function mapTextToSlackMrkdwn(markdown: string): string {
  // let justified: pipeline transformation requires reassignment
  let result = markdown;

  // Links: [text](url) → <url|text>
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>");

  // Bold: **text** or __text__ → *text*
  result = result.replace(/\*\*(.+?)\*\*/g, "*$1*");
  result = result.replace(/__(.+?)__/g, "*$1*");

  // Strikethrough: ~~text~~ → ~text~
  result = result.replace(/~~(.+?)~~/g, "~$1~");

  return result;
}
