/**
 * E.164 phone number normalization for Signal.
 *
 * Validates and normalizes phone numbers to E.164 format (+country code).
 * OpenClaw pattern: all phone inputs are normalized before use.
 */

/** E.164 format: + followed by 1-15 digits. */
const E164_REGEX = /^\+[1-9]\d{1,14}$/;

/**
 * Returns true if the input is a valid E.164 phone number.
 */
export function isE164(phone: string): boolean {
  return E164_REGEX.test(phone);
}

/**
 * Normalizes a phone number string to E.164 format.
 *
 * Strips whitespace, dashes, dots, and parentheses.
 * Ensures the result starts with "+".
 * Returns null if the result is not valid E.164.
 */
export function normalizeE164(phone: string): string | null {
  // Strip common formatting characters
  const stripped = phone.replace(/[\s\-.()/]/g, "");

  // If already E.164, return as-is
  if (E164_REGEX.test(stripped)) {
    return stripped;
  }

  // Try prepending "+" if it looks like digits only
  if (/^[1-9]\d{1,14}$/.test(stripped)) {
    return `+${stripped}`;
  }

  return null;
}
