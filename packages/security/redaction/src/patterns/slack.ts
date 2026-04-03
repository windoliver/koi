/**
 * Slack token detector — matches `xoxp-`, `xoxb-`, `xoxa-`, `xoxo-` prefixed tokens.
 */

import type { SecretMatch, SecretPattern } from "../types.js";
import { collectMatches, EMPTY_MATCHES } from "./collect.js";

const SLACK_PATTERN = /xox[pboa]-[0-9]{10,}-[a-zA-Z0-9-]+/g;

export function createSlackDetector(): SecretPattern {
  return {
    name: "slack_token",
    kind: "slack_token",
    detect(text: string): readonly SecretMatch[] {
      if (
        !text.includes("xoxp-") &&
        !text.includes("xoxb-") &&
        !text.includes("xoxa-") &&
        !text.includes("xoxo-")
      )
        return EMPTY_MATCHES;
      return collectMatches(text, SLACK_PATTERN, "slack_token");
    },
  };
}
