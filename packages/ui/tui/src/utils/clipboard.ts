/**
 * Terminal clipboard utility using OSC 52 escape sequence.
 *
 * OSC 52 is supported by most modern terminals (iTerm2, Ghostty, WezTerm,
 * Kitty, Alacritty, Windows Terminal). Falls back to a no-op if stdout
 * is not a TTY.
 *
 * @see https://invisible-island.net/xterm/ctlseqs/ctlseqs.html#h3-Operating-System-Commands
 */

/**
 * Safe upper bound for OSC 52 payload size in bytes.
 * Terminal-dependent; 100 KB is a conservative default that works
 * across iTerm2, Ghostty, WezTerm, and Kitty.
 */
export const MAX_CLIPBOARD_BYTES = 100_000;

/**
 * Copy text to the system clipboard via OSC 52 terminal escape sequence.
 *
 * Returns `true` if the sequence was written, `false` if stdout is not a TTY.
 */
export function copyToClipboard(text: string): boolean {
  if (!process.stdout.isTTY) return false;

  const base64 = Buffer.from(text).toString("base64");
  process.stdout.write(`\x1b]52;c;${base64}\x07`);
  return true;
}
