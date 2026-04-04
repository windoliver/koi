import { describe, expect, test } from "bun:test";
import { createAWSDetector } from "./aws.js";
import { createBearerDetector } from "./bearer.js";
import { createGitHubDetector } from "./github.js";
import { createUrlDecodingDetector } from "./url-decode.js";

function createDetector() {
  return createUrlDecodingDetector([
    createAWSDetector(),
    createGitHubDetector(),
    createBearerDetector(),
  ]);
}

describe("createUrlDecodingDetector", () => {
  test("detects URL-encoded GitHub token", () => {
    const detector = createDetector();
    // Wrap token with chars that get percent-encoded to create detectable URL encoding
    const payload = "token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijkl&type=pat";
    const encoded = encodeURIComponent(payload);
    const matches = detector.detect(`https://evil.com/?data=${encoded}`);

    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]?.kind).toBe("url_encoded_github_token");
  });

  test("detects URL-encoded AWS key", () => {
    const detector = createDetector();
    // Include = and & chars that get percent-encoded
    const payload = "key=AKIAIOSFODNN7EXAMPLE&region=us-east-1";
    const encoded = encodeURIComponent(payload);
    const matches = detector.detect(`data=${encoded}`);

    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]?.kind).toBe("url_encoded_aws_access_key");
  });

  test("ignores benign URL encoding", () => {
    const detector = createDetector();
    // Normal URL with spaces encoded — no secrets
    const matches = detector.detect("https://example.com/search?q=hello%20world%20foo%20bar%20baz");

    expect(matches).toHaveLength(0);
  });

  test("ignores strings without percent encoding", () => {
    const detector = createDetector();
    const matches = detector.detect("just a normal string with no encoding");

    expect(matches).toHaveLength(0);
  });

  test("handles invalid percent sequences gracefully", () => {
    const detector = createDetector();
    // Contains invalid percent encoding
    const matches = detector.detect("data=%ZZ%XX%YY%AA%BB%CC%DD%EE%FF");

    // Should not throw
    expect(matches).toHaveLength(0);
  });

  test("requires minimum encoded sequences threshold", () => {
    const detector = createDetector();
    // Only 1-2 percent-encoded pairs — below threshold
    const matches = detector.detect("path/to/file%20name%20here");

    expect(matches).toHaveLength(0);
  });

  test("returns correct start/end positions", () => {
    const detector = createDetector();
    // Wrap the token with chars that get percent-encoded (spaces, colons)
    const payload = "Authorization: Bearer ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijkl header";
    const encoded = encodeURIComponent(payload);
    const prefix = "data=";
    const text = `${prefix}${encoded}`;
    const matches = detector.detect(text);

    expect(matches.length).toBeGreaterThan(0);
    // The match should encompass the encoded segment
    expect(matches[0]?.start).toBeGreaterThanOrEqual(0);
    expect(matches[0]?.end).toBeGreaterThan(matches[0]?.start ?? 0);
  });

  test("has correct name and kind", () => {
    const detector = createDetector();
    expect(detector.name).toBe("url_decode");
    expect(detector.kind).toBe("url_encoded");
  });
});
