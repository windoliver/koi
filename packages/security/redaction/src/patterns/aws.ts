/**
 * AWS Access Key ID detector — matches `AKIA` followed by 16 uppercase alphanumeric chars.
 */

import type { SecretMatch, SecretPattern } from "../types.js";
import { collectMatches, EMPTY_MATCHES } from "./collect.js";

const AWS_PATTERN = /AKIA[0-9A-Z]{16}/g;

export function createAWSDetector(): SecretPattern {
  return {
    name: "aws_access_key",
    kind: "aws_access_key",
    detect(text: string): readonly SecretMatch[] {
      if (!text.includes("AKIA")) return EMPTY_MATCHES;
      return collectMatches(text, AWS_PATTERN, "aws_access_key");
    },
  };
}
