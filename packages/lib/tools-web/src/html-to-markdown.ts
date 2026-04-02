/**
 * HTML-to-Markdown conversion. Zero external dependencies.
 */

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

function cleanInline(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function htmlToMarkdown(html: string): string {
  // justified: let — must be reassigned in sequential transformations
  let text = html.replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, "");
  text = text.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level, content) => {
    return `\n${"#".repeat(parseInt(level, 10))} ${cleanInline(content)}\n`;
  });
  text = text.replace(
    /<a\s+[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
    (_m, href, content) => `[${cleanInline(content)}](${href})`,
  );
  text = text.replace(
    /<(?:strong|b)[^>]*>([\s\S]*?)<\/(?:strong|b)>/gi,
    (_m, c) => `**${cleanInline(c)}**`,
  );
  text = text.replace(/<(?:em|i)[^>]*>([\s\S]*?)<\/(?:em|i)>/gi, (_m, c) => `*${cleanInline(c)}*`);
  text = text.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_m, c) => `\`${cleanInline(c)}\``);
  text = text.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_m, c) => {
    return `\n\`\`\`\n${cleanInline(c).trim()}\n\`\`\`\n`;
  });
  text = text.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_m, c) => {
    return `\n${cleanInline(c)
      .trim()
      .split("\n")
      .map((l) => `> ${l}`)
      .join("\n")}\n`;
  });
  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, c) => `\n- ${cleanInline(c).trim()}`);
  text = text.replace(/<hr[^>]*\/?>/gi, "\n---\n");
  text = text.replace(/<br[^>]*\/?>/gi, "\n");
  text = text.replace(
    /<\/?(?:p|div|tr|section|article|header|footer|nav|main|aside|ul|ol|table)[^>]*>/gi,
    "\n",
  );
  text = text.replace(/<[^>]+>/g, "");
  text = decodeEntities(text);
  text = text
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text;
}
