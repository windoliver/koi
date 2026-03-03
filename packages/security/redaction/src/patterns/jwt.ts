/**
 * JWT token detector — matches base64url-encoded `eyJ...` three-part tokens.
 */

import type { SecretPattern } from "../types.js";
import { collectMatches, EMPTY_MATCHES } from "./collect.js";

const JWT_PATTERN = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;

export function createJWTDetector(): SecretPattern {
  return {
    name: "jwt",
    kind: "jwt",
    detect(text: string): readonly import("../types.js").SecretMatch[] {
      if (!text.includes("eyJ")) return EMPTY_MATCHES;
      return collectMatches(text, JWT_PATTERN, "jwt");
    },
  };
}
