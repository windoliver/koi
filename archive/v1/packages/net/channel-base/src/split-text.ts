/**
 * Splits text into chunks of at most `limit` characters.
 * Prefers splitting at newlines to avoid cutting mid-sentence.
 *
 * @param inputText - The text to split.
 * @param limit - Maximum character count per chunk.
 * @returns An array of text chunks, each at most `limit` characters.
 */
export function splitText(inputText: string, limit: number): readonly string[] {
  if (inputText.length <= limit) {
    return [inputText];
  }

  const parts: string[] = [];
  // let requires justification: cursor position advances through remaining text
  let remaining = inputText;

  while (remaining.length > limit) {
    const slice = remaining.slice(0, limit);
    const lastNewline = slice.lastIndexOf("\n");
    const splitAt = lastNewline > 0 ? lastNewline + 1 : limit;
    parts.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining.length > 0) {
    parts.push(remaining);
  }

  return parts;
}
