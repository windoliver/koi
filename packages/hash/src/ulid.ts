/**
 * ULID generator — crypto-random, time-sortable, 26-char Crockford Base32.
 *
 * No external dependencies. Uses crypto.getRandomValues() for randomness.
 */

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford Base32

function encodeTime(now: number, length: number): string {
  let result = "";
  // let is required: loop mutates `now` on each iteration
  let remaining = now;
  for (let i = length; i > 0; i--) {
    result = (ENCODING[remaining % 32] ?? "0") + result;
    remaining = Math.floor(remaining / 32);
  }
  return result;
}

function encodeRandom(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let result = "";
  for (let i = 0; i < length; i++) {
    result += ENCODING[(bytes[i] ?? 0) % 32];
  }
  return result;
}

/** Generate a ULID — 26-char, time-sortable, crypto-random unique ID. */
export function generateUlid(): string {
  return encodeTime(Date.now(), 10) + encodeRandom(16);
}
