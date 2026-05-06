/**
 * E.164 phone-number validation + normalization.
 *
 * Format: leading "+" followed by 1–15 digits, first digit non-zero.
 */

const E164_REGEX = /^\+[1-9]\d{1,14}$/;

export function isE164(phone: string): boolean {
  return E164_REGEX.test(phone);
}

/**
 * Strips formatting (whitespace, dashes, dots, parens, slashes) and prepends
 * "+" if the input was bare digits. Returns null for inputs that cannot be
 * coerced into a valid E.164 string.
 */
export function normalizeE164(phone: string): string | null {
  const stripped = phone.replace(/[\s\-.()/]/g, "");
  if (E164_REGEX.test(stripped)) return stripped;
  if (/^[1-9]\d{1,14}$/.test(stripped)) return `+${stripped}`;
  return null;
}
