import { describe, expect, test } from "bun:test";
import {
  createApiKeyDetector,
  createEmailDetector,
  createPiiDetector,
  createSsnDetector,
} from "../pii.js";

describe("createEmailDetector", () => {
  const detector = createEmailDetector();

  test("kind is email", () => {
    expect(detector.kind).toBe("email");
  });

  test("detects simple email address", () => {
    const matches = detector.detect("Contact me at user@example.com for details.");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.value).toBe("user@example.com");
    expect(matches[0]?.kind).toBe("email");
  });

  test("detects multiple emails", () => {
    const matches = detector.detect("alice@a.com and bob@b.org are both invited.");
    expect(matches).toHaveLength(2);
    expect(matches.map((m) => m.value)).toEqual(["alice@a.com", "bob@b.org"]);
  });

  test("returns empty for text with no email", () => {
    const matches = detector.detect("No email here, just plain text.");
    expect(matches).toHaveLength(0);
  });

  test("does not false-positive on email-like strings without tld", () => {
    const matches = detector.detect("user@hostname is not a real email");
    expect(matches).toHaveLength(0);
  });

  test("records correct start/end offsets", () => {
    const text = "send to user@example.com today";
    const matches = detector.detect(text);
    expect(matches).toHaveLength(1);
    const m = matches[0];
    expect(m).toBeDefined();
    if (m !== undefined) {
      expect(text.slice(m.start, m.end)).toBe("user@example.com");
    }
  });
});

describe("createSsnDetector", () => {
  const detector = createSsnDetector();

  test("kind is ssn", () => {
    expect(detector.kind).toBe("ssn");
  });

  test("detects SSN in XXX-XX-XXXX format", () => {
    const matches = detector.detect("Social security: 123-45-6789.");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.value).toBe("123-45-6789");
    expect(matches[0]?.kind).toBe("ssn");
  });

  test("does not detect partial SSN pattern (phone number 123-456-7890)", () => {
    const matches = detector.detect("phone: 123-456-7890");
    expect(matches).toHaveLength(0);
  });

  test("does not false-positive on date strings like 2024-01-15", () => {
    const matches = detector.detect("date: 2024-01-15 is not an SSN");
    expect(matches).toHaveLength(0);
  });

  test("returns empty for clean text", () => {
    const matches = detector.detect("No sensitive data here.");
    expect(matches).toHaveLength(0);
  });

  test("detects multiple SSNs in one string", () => {
    const matches = detector.detect("First SSN: 123-45-6789. Second SSN: 234-56-7890.");
    expect(matches).toHaveLength(2);
  });
});

describe("createApiKeyDetector", () => {
  const detector = createApiKeyDetector();

  test("kind is api_key", () => {
    expect(detector.kind).toBe("api_key");
  });

  test("detects OpenAI sk- key", () => {
    const matches = detector.detect("key=sk-aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789abcd");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.kind).toBe("api_key");
    expect(matches[0]?.value).toMatch(/^sk-/);
  });

  test("detects AWS IAM key AKIA...", () => {
    const matches = detector.detect("AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.value).toMatch(/^AKIA/);
  });

  test("detects GitHub personal access token ghp_", () => {
    const matches = detector.detect("token: ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789a");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.value).toMatch(/^ghp_/);
  });

  test("detects Slack bot token xoxb-", () => {
    const matches = detector.detect(
      "SLACK_TOKEN=xoxb-12345678901-aBcDeFgHiJkLmNoPqRsTuVwXy1234567abc",
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]?.value).toMatch(/^xoxb-/);
  });

  test("returns empty for short alphanumeric strings", () => {
    const matches = detector.detect("id=abc123 ref=xyz456");
    expect(matches).toHaveLength(0);
  });

  test("does not false-positive on UUIDs", () => {
    const matches = detector.detect("id=550e8400-e29b-41d4-a716-446655440000");
    expect(matches).toHaveLength(0);
  });

  test("detects multiple different vendor keys in one string", () => {
    const multiKeyText =
      "openai=sk-aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789abcd aws=AKIAIOSFODNN7EXAMPLE";
    const matches = detector.detect(multiKeyText);
    expect(matches).toHaveLength(2);
    expect(matches.some((m) => m.value.startsWith("sk-"))).toBe(true);
    expect(matches.some((m) => m.value.startsWith("AKIA"))).toBe(true);
  });
});

describe("createPiiDetector (composite)", () => {
  test("kind is the first kind when single", () => {
    const d = createPiiDetector(["email"]);
    expect(d.kind).toBe("email");
  });

  test("kind is composite label when multiple", () => {
    const d = createPiiDetector(["email", "ssn"]);
    expect(d.kind).toBe("email,ssn");
  });

  test("detects from all requested kinds", () => {
    const d = createPiiDetector(["email", "ssn", "api_key"]);
    const matches = d.detect(
      "user@example.com, SSN 123-45-6789, key sk-aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789abcd",
    );
    const kinds = matches.map((m) => m.kind);
    expect(kinds).toContain("email");
    expect(kinds).toContain("ssn");
    expect(kinds).toContain("api_key");
  });

  test("deduplicates same kind if specified twice", () => {
    const d = createPiiDetector(["email", "email"]);
    const matches = d.detect("user@example.com");
    expect(matches).toHaveLength(1);
  });
});
