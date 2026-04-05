import { describe, expect, test } from "bun:test";
import { PATH_BYPASS_CASES, SAFE_CASES } from "./__tests__/bypass-cases.js";
import { validatePath } from "./path-validator.js";

describe("validatePath", () => {
  describe("blocks raw directory traversal", () => {
    test("double-dot slash", () => {
      const result = validatePath("../../etc/passwd");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.category).toBe("path-traversal");
    });

    test("single-level traversal", () => {
      expect(validatePath("../secret").ok).toBe(false);
    });

    test("trailing double-dot", () => {
      expect(validatePath("/var/www/..").ok).toBe(false);
    });

    test("backslash traversal", () => {
      expect(validatePath("..\\etc\\passwd").ok).toBe(false);
    });
  });

  describe("blocks URL-encoded traversal", () => {
    test("lowercase %2e%2e", () => {
      const result = validatePath("%2e%2e%2fetc%2fpasswd");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.category).toBe("path-traversal");
        expect(result.reason).toMatch(/URL-encoded/i);
      }
    });

    test("uppercase %2E%2E", () => {
      expect(validatePath("%2E%2E/etc/passwd").ok).toBe(false);
    });
  });

  describe("blocks double URL-encoded traversal", () => {
    test("%252e%252e", () => {
      const result = validatePath("%252e%252e%252f");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/double/i);
    });
  });

  describe("blocks null byte injection", () => {
    test("null byte in path", () => {
      expect(validatePath("/valid/path\x00/../etc/passwd").ok).toBe(false);
    });
  });

  describe("blocks non-printable characters", () => {
    test("backspace control character", () => {
      expect(validatePath("/var/www/\x08config").ok).toBe(false);
    });

    test("other control characters", () => {
      expect(validatePath("/path/with/\x01/char").ok).toBe(false);
      expect(validatePath("/path/with/\x1f/char").ok).toBe(false);
    });
  });

  describe("base-directory containment (with baseDir)", () => {
    test("allows path within base dir", () => {
      expect(validatePath("packages/lib", "/workspace").ok).toBe(true);
    });

    test("allows exact base dir match", () => {
      expect(validatePath("/workspace", "/workspace").ok).toBe(true);
    });

    test("blocks path resolving outside base dir", () => {
      const result = validatePath("/etc/passwd", "/workspace");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.category).toBe("path-traversal");
        expect(result.reason).toMatch(/outside/);
      }
    });

    test("blocks traversal that resolves outside", () => {
      // Even though ../ is caught by pattern, test the realpath check independently
      // by providing a path that resolves outside after canonicalization
      const result = validatePath("/etc/passwd", "/workspace");
      expect(result.ok).toBe(false);
    });

    test("blocks base-dir prefix collision", () => {
      // /workspaceExtra should NOT be considered inside /workspace
      const result = validatePath("/workspaceExtra/secrets", "/workspace");
      expect(result.ok).toBe(false);
    });
  });

  describe("allows safe paths", () => {
    test("simple relative path", () => {
      expect(validatePath("packages/lib/errors").ok).toBe(true);
    });

    test("absolute path (no baseDir)", () => {
      expect(validatePath("/var/www/html/index.html").ok).toBe(true);
    });

    test("path with dots in filename", () => {
      expect(validatePath("src/index.test.ts").ok).toBe(true);
    });

    test("path with hyphens and underscores", () => {
      expect(validatePath("my-package_v2/src/index.ts").ok).toBe(true);
    });

    const safePaths = SAFE_CASES.filter((c) => c.classifier === "any");
    for (const { input, description } of safePaths) {
      test(`safe: ${description}`, () => {
        // Safe commands are not paths, but they shouldn't trigger path traversal
        expect(validatePath(input).ok).toBe(true);
      });
    }
  });

  describe("bypass case coverage", () => {
    for (const { input, shouldBlock, description } of PATH_BYPASS_CASES) {
      test(`${shouldBlock ? "blocks" : "allows"}: ${description}`, () => {
        const result = validatePath(input);
        expect(result.ok).toBe(!shouldBlock);
      });
    }
  });

  describe("ClassificationResult shape", () => {
    test("blocked result has all required fields", () => {
      const result = validatePath("../../etc");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(typeof result.reason).toBe("string");
        expect(result.reason.length).toBeGreaterThan(0);
        expect(typeof result.pattern).toBe("string");
        expect(result.category).toBe("path-traversal");
      }
    });
  });
});
