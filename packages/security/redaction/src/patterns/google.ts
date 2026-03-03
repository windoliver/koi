/**
 * Google API key detector — matches `AIza` prefixed keys (Maps, Firebase, Vertex AI, Gemini).
 */

import type { SecretMatch, SecretPattern } from "../types.js";
import { collectMatches, EMPTY_MATCHES } from "./collect.js";

const GOOGLE_PATTERN = /AIza[0-9A-Za-z\-_]{35}/g;

export function createGoogleDetector(): SecretPattern {
  return {
    name: "google_api_key",
    kind: "google_api_key",
    detect(text: string): readonly SecretMatch[] {
      if (!text.includes("AIza")) return EMPTY_MATCHES;
      return collectMatches(text, GOOGLE_PATTERN, "google_api_key");
    },
  };
}
