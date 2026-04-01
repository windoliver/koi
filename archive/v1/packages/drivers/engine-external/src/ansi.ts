/**
 * ANSI escape sequence stripping using Node.js built-in.
 */

import { stripVTControlCharacters } from "node:util";

/** Strip all ANSI/VT control characters from text. */
export function stripAnsi(text: string): string {
  return stripVTControlCharacters(text);
}
