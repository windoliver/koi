import { describe, expect, test } from "bun:test";
import type { MemoryRecord, MemoryRecordId } from "@koi/core";
import { filterMemoriesForSync, filterMemoryForSync } from "./filter.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMemory(
  id: string,
  type: "user" | "feedback" | "project" | "reference",
  content: string = "some safe content",
): MemoryRecord {
  return {
    id: id as MemoryRecordId,
    name: `Memory ${id}`,
    description: `Description for ${id}`,
    type,
    content,
    filePath: `${id}.md`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// filterMemoryForSync
// ---------------------------------------------------------------------------

describe("filterMemoryForSync", () => {
  describe("type filtering", () => {
    test("always denies user type", () => {
      const result = filterMemoryForSync(createMemory("1", "user"));
      expect(result.passed).toBe(false);
      expect(result.blocked?.reason).toBe("type_denied");
      expect(result.blocked?.detail).toContain("user");
    });

    test("denies user type even when explicitly in allowedTypes", () => {
      const result = filterMemoryForSync(createMemory("1", "user"), ["user", "feedback"]);
      expect(result.passed).toBe(false);
      expect(result.blocked?.reason).toBe("type_denied");
    });

    test("allows feedback type by default", () => {
      const result = filterMemoryForSync(createMemory("1", "feedback"));
      expect(result.passed).toBe(true);
    });

    test("allows project type by default", () => {
      const result = filterMemoryForSync(createMemory("1", "project"));
      expect(result.passed).toBe(true);
    });

    test("allows reference type by default", () => {
      const result = filterMemoryForSync(createMemory("1", "reference"));
      expect(result.passed).toBe(true);
    });

    test("denies type not in custom allowedTypes", () => {
      const result = filterMemoryForSync(createMemory("1", "reference"), ["feedback"]);
      expect(result.passed).toBe(false);
      expect(result.blocked?.reason).toBe("type_denied");
    });
  });

  // Regression #1964: contact data privacy — primary boundary is user-type hardblock;
  // secondary boundary is email backstop on reference memories.
  describe("contact data privacy (regression #1964)", () => {
    test("blocks personal contact correctly classified as user", () => {
      const memory = createMemory("1", "user", "infra contact: alice@example.com");
      const result = filterMemoryForSync(memory);
      expect(result.passed).toBe(false);
      expect(result.blocked?.reason).toBe("type_denied");
    });

    test("blocks reference memory containing email — misclassification backstop", () => {
      const memory = createMemory("1", "reference", "infra contact: alice@example.com");
      const result = filterMemoryForSync(memory);
      expect(result.passed).toBe(false);
      expect(result.blocked?.reason).toBe("secret_detected");
      expect(result.blocked?.detail).toContain("personal contacts as user type");
    });

    test("allows reference memory with SSH git remote (git@github.com:org/repo)", () => {
      // SSH git remotes have `:` after the domain — excluded by PERSONAL_EMAIL_PATTERN
      const memory = createMemory("1", "reference", "repo: git@github.com:org/koi.git");
      const result = filterMemoryForSync(memory);
      expect(result.passed).toBe(true);
    });

    test("allows reference memory with clean system/tool pointer", () => {
      const memory = createMemory("1", "reference", "bugs tracked in Linear INGEST project");
      const result = filterMemoryForSync(memory);
      expect(result.passed).toBe(true);
    });

    test("allows feedback memory with email in operational content", () => {
      // feedback memories may legitimately reference emails in guidance context
      const memory = createMemory(
        "1",
        "feedback",
        "escalate to oncall-eng@company.com for prod issues",
      );
      const result = filterMemoryForSync(memory);
      expect(result.passed).toBe(true);
    });
  });

  describe("secret scanning", () => {
    test("blocks memory with password in content", () => {
      const memory = createMemory(
        "1",
        "feedback",
        "config password=SuperSecret12345678 was loaded",
      );
      const result = filterMemoryForSync(memory);
      expect(result.passed).toBe(false);
      expect(result.blocked?.reason).toBe("secret_detected");
    });

    test("blocks memory with PEM key in content", () => {
      const memory = createMemory(
        "1",
        "feedback",
        "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0Z3VS\n-----END RSA PRIVATE KEY-----",
      );
      const result = filterMemoryForSync(memory);
      expect(result.passed).toBe(false);
      expect(result.blocked?.reason).toBe("secret_detected");
    });

    test("passes memory with clean content", () => {
      const memory = createMemory("1", "feedback", "Always validate input at system boundaries");
      const result = filterMemoryForSync(memory);
      expect(result.passed).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// filterMemoriesForSync
// ---------------------------------------------------------------------------

describe("filterMemoriesForSync", () => {
  test("partitions memories into eligible and blocked", () => {
    const memories = [
      createMemory("1", "feedback", "safe content"),
      createMemory("2", "user", "private info"),
      createMemory("3", "project", "also safe"),
    ];
    const { eligible, blocked } = filterMemoriesForSync(memories);

    expect(eligible).toHaveLength(2);
    expect(blocked).toHaveLength(1);
    expect(blocked[0]?.reason).toBe("type_denied");
  });

  test("returns empty lists for empty input", () => {
    const { eligible, blocked } = filterMemoriesForSync([]);
    expect(eligible).toHaveLength(0);
    expect(blocked).toHaveLength(0);
  });

  test("blocks all memories when all have secrets", () => {
    const memories = [
      createMemory("1", "feedback", "password=MySuperSecretPassword123"),
      createMemory("2", "project", "token=AbcDefGhiJklMnoPqrs"),
    ];
    const { eligible, blocked } = filterMemoriesForSync(memories);

    expect(eligible).toHaveLength(0);
    expect(blocked).toHaveLength(2);
  });
});
