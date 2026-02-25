/**
 * Built-in PII detectors — 7 factory functions with signal-character short-circuit.
 */

import type { PIIDetector, PIIMatch } from "./types.js";

// Pre-compiled patterns at module level
const EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const CREDIT_CARD_PATTERN = /\b(?:\d{4}[-\s]?){3}\d{4}\b/g;
const IP_PATTERN = /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g;
const MAC_PATTERN = /\b(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b/gi;
const URL_PATTERN = /(?:https?:\/\/|www\.)[^\s<>"{}|\\^`[\]]+/gi;
const SSN_PATTERN = /\b\d{3}-\d{2}-\d{4}\b/g;
const PHONE_PATTERN = /(?:\+\d{1,3}[-.\s]?)?(?:\(\d{3}\)|\d{3})[-.\s]\d{3}[-.\s]\d{4}\b/g;

/** Trailing punctuation that should not be part of a URL. */
const URL_TRAILING = /[.,)]+$/;

/** Luhn checksum validation for credit card numbers. */
function isValidLuhn(digits: string): boolean {
  const nums = digits.replace(/\D/g, "");
  const len = nums.length;
  if (len < 13 || len > 19) return false;

  // let justified: luhn algorithm accumulator
  let sum = 0;
  // let justified: alternating flag for luhn algorithm
  let alternate = false;

  for (let i = len - 1; i >= 0; i--) {
    // let justified: current digit being processed in luhn step
    let n = Number(nums[i]);
    if (alternate) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

function collectMatches(
  text: string,
  pattern: RegExp,
  kind: string,
  validate?: (match: string) => boolean,
  postProcess?: (match: RegExpExecArray) => { readonly text: string; readonly end: number },
): readonly PIIMatch[] {
  const results: PIIMatch[] = [];
  // Reset lastIndex for global regex reuse
  pattern.lastIndex = 0;

  // let justified: regex exec loop variable
  let m: RegExpExecArray | null = pattern.exec(text);
  while (m !== null) {
    const processed = postProcess?.(m);
    const matchText = processed?.text ?? m[0];
    const end = processed?.end ?? m.index + m[0].length;

    if (validate === undefined || validate(matchText)) {
      results.push({
        text: matchText,
        start: m.index,
        end,
        kind,
      });
    }
    m = pattern.exec(text);
  }
  return results;
}

/** Creates an email address detector. Signal character: `@`. */
export function createEmailDetector(): PIIDetector {
  return {
    name: "email",
    kind: "email",
    detect(text: string): readonly PIIMatch[] {
      if (!text.includes("@")) return [];
      return collectMatches(text, EMAIL_PATTERN, "email");
    },
  };
}

/** Creates a credit card number detector with Luhn validation. Signal: digit density. */
export function createCreditCardDetector(): PIIDetector {
  return {
    name: "credit_card",
    kind: "credit_card",
    detect(text: string): readonly PIIMatch[] {
      // Signal check: must have at least 13 consecutive digits (with optional separators)
      if (!/\d{4}/.test(text)) return [];
      return collectMatches(text, CREDIT_CARD_PATTERN, "credit_card", isValidLuhn);
    },
  };
}

/** Creates an IPv4 address detector. Signal: `.` + digit. */
export function createIPDetector(): PIIDetector {
  return {
    name: "ip",
    kind: "ip",
    detect(text: string): readonly PIIMatch[] {
      if (!text.includes(".") || !/\d/.test(text)) return [];
      return collectMatches(text, IP_PATTERN, "ip");
    },
  };
}

/** Creates a MAC address detector. Signal: `:` or `-` + hex. */
export function createMACDetector(): PIIDetector {
  return {
    name: "mac",
    kind: "mac",
    detect(text: string): readonly PIIMatch[] {
      if (!text.includes(":") && !text.includes("-")) return [];
      if (!/[0-9A-Fa-f]{2}/.test(text)) return [];
      return collectMatches(text, MAC_PATTERN, "mac");
    },
  };
}

/** Creates a URL detector. Signal: `://` or `www.`. */
export function createURLDetector(): PIIDetector {
  return {
    name: "url",
    kind: "url",
    detect(text: string): readonly PIIMatch[] {
      if (!text.includes("://") && !text.includes("www.")) return [];
      return collectMatches(text, URL_PATTERN, "url", undefined, (m) => {
        const stripped = m[0].replace(URL_TRAILING, "");
        return { text: stripped, end: m.index + stripped.length };
      });
    },
  };
}

/** Validate SSN area/group/serial per SSA rules. */
function isValidSSN(text: string): boolean {
  const parts = text.split("-");
  if (parts.length !== 3) return false;
  const area = Number(parts[0]);
  const group = Number(parts[1]);
  const serial = Number(parts[2]);
  // Area cannot be 000, 666, or 900-999
  if (area === 0 || area === 666 || area >= 900) return false;
  // Group and serial cannot be 00 / 0000
  if (group === 0 || serial === 0) return false;
  return true;
}

/** Validate phone has 10-15 digits (E.164 range). */
function isValidPhone(text: string): boolean {
  const digits = text.replace(/\D/g, "");
  return digits.length >= 10 && digits.length <= 15;
}

/** Creates a US Social Security Number detector. Signal: `-` + digit groups. */
export function createSSNDetector(): PIIDetector {
  return {
    name: "ssn",
    kind: "ssn",
    detect(text: string): readonly PIIMatch[] {
      if (!text.includes("-") || !/\d{3}-\d{2}/.test(text)) return [];
      return collectMatches(text, SSN_PATTERN, "ssn", isValidSSN);
    },
  };
}

/** Creates a phone number detector. Signal: `(`, `+`, or digit-separator patterns. */
export function createPhoneDetector(): PIIDetector {
  return {
    name: "phone",
    kind: "phone",
    detect(text: string): readonly PIIMatch[] {
      // Need separators (-, ., or parens) adjacent to digits to avoid false positives
      if (!/\d[-.(]/.test(text) && !/[-.)\d]\d/.test(text)) return [];
      if (!/\+|\(|\d[-.]/.test(text)) return [];
      return collectMatches(text, PHONE_PATTERN, "phone", isValidPhone);
    },
  };
}

/** All 7 built-in detectors in standard order. */
export function createAllDetectors(): readonly PIIDetector[] {
  return [
    createEmailDetector(),
    createCreditCardDetector(),
    createIPDetector(),
    createMACDetector(),
    createURLDetector(),
    createSSNDetector(),
    createPhoneDetector(),
  ];
}
