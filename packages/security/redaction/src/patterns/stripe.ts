/**
 * Stripe key detector — matches `sk_live_` and `pk_live_` prefixed keys.
 */

import type { SecretMatch, SecretPattern } from "../types.js";
import { collectMatches, EMPTY_MATCHES } from "./collect.js";

const STRIPE_PATTERN = /[sp]k_live_[0-9a-zA-Z]{24,}/g;

export function createStripeDetector(): SecretPattern {
  return {
    name: "stripe_key",
    kind: "stripe_key",
    detect(text: string): readonly SecretMatch[] {
      if (!text.includes("sk_live_") && !text.includes("pk_live_")) return EMPTY_MATCHES;
      return collectMatches(text, STRIPE_PATTERN, "stripe_key");
    },
  };
}
