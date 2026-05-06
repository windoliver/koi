/**
 * @koi/channel-email — re-export shim defining the MimeParser DI seam.
 */

import type { ParsedMail } from "./normalize.js";

export type { ParsedMail } from "./normalize.js";
export { normalizeEmail } from "./normalize.js";

export interface MimeParser {
  parse(raw: Uint8Array): Promise<ParsedMail>;
}
