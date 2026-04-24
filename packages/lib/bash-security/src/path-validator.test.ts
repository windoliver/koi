import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PATH_BYPASS_CASES, SAFE_CASES } from "./bypass-cases.js";
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
      // Base + path must both exist (strict-intermediate rule).
      const base = mkdtempSync(join(tmpdir(), "koi-pv-contain-"));
      try {
        mkdirSync(join(base, "packages", "lib"), { recursive: true });
        expect(validatePath("packages/lib", base).ok).toBe(true);
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    });

    test("allows exact base dir match", () => {
      const base = mkdtempSync(join(tmpdir(), "koi-pv-exact-"));
      try {
        expect(validatePath(base, base).ok).toBe(true);
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    });

    test("blocks path resolving outside base dir", () => {
      const base = mkdtempSync(join(tmpdir(), "koi-pv-outside-"));
      try {
        const result = validatePath("/etc/passwd", base);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.category).toBe("path-traversal");
          expect(result.reason).toMatch(/outside/);
        }
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    });

    test("blocks traversal that resolves outside", () => {
      // Even though ../ is caught by pattern, test the realpath check independently
      // by providing a path that resolves outside after canonicalization.
      const base = mkdtempSync(join(tmpdir(), "koi-pv-trav-"));
      try {
        const result = validatePath("/etc/passwd", base);
        expect(result.ok).toBe(false);
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    });

    test("blocks base-dir prefix collision", () => {
      // /tmp/koi-pv-foo-SIBLING should NOT be considered inside /tmp/koi-pv-foo-BASE
      const base = mkdtempSync(join(tmpdir(), "koi-pv-pfx-"));
      const sibling = mkdtempSync(join(tmpdir(), "koi-pv-pfx-"));
      try {
        const result = validatePath(sibling, base);
        expect(result.ok).toBe(false);
      } finally {
        rmSync(base, { recursive: true, force: true });
        rmSync(sibling, { recursive: true, force: true });
      }
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

  describe("symlink containment (realpath canonicalization)", () => {
    test("BUG regression: blocks write to non-existent leaf beyond symlink pointing outside base", () => {
      // Regression for symlink-bypass bug: when realpathSync threw ENOENT on a
      // non-existent leaf, the fallback used string-only resolve() which did
      // NOT follow symlinks — allowing workspace/evil/new-file to land in /etc.
      const base = mkdtempSync(join(tmpdir(), "koi-pv-symlink-"));
      try {
        const ws = join(base, "workspace");
        mkdirSync(ws);
        symlinkSync("/etc", join(ws, "evil"));
        const result = validatePath(join(ws, "evil/brand-new-file"), ws);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.category).toBe("path-traversal");
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    });

    test("BUG regression: allows creating a new file under a base dir whose path contains a symlink prefix (macOS /tmp → /private/tmp)", () => {
      // Regression: on macOS, /tmp is a symlink to /private/tmp. canonicalBase
      // went through realpathSync but canonicalPath fell back to string-only
      // resolve(), so they had different prefixes and every create-new-file
      // under /tmp/<base> was blocked as a false positive.
      const base = mkdtempSync(join(tmpdir(), "koi-pv-tmpsym-"));
      try {
        const ws = join(base, "workspace");
        mkdirSync(ws);
        const result = validatePath(join(ws, "new-file.txt"), ws);
        expect(result.ok).toBe(true);
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    });

    test("BUG regression: dangling symlink pointing outside base is rejected (TOCTOU defense)", () => {
      // A symlink whose target does not exist yet would pass the old walk
      // because realpathSync threw and the walk treated the symlink name as
      // a missing leaf. An attacker can later materialize the outside target
      // between validation and the actual write. Reject such paths outright.
      const base = mkdtempSync(join(tmpdir(), "koi-pv-dangling-"));
      try {
        const ws = join(base, "workspace");
        mkdirSync(ws);
        // target does NOT exist yet
        symlinkSync("/etc/brand-new-leaf-that-does-not-exist", join(ws, "trap"));
        const result = validatePath(join(ws, "trap"), ws);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.category).toBe("path-traversal");
          expect(result.reason).toMatch(/dangling symlink/);
        }
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    });

    test("allows non-existent leaf under base when its parent exists", () => {
      // Strict-intermediate rule: only the leaf may be missing. Parent MUST
      // already exist and realpath cleanly inside the base.
      const base = mkdtempSync(join(tmpdir(), "koi-pv-leaf-"));
      try {
        mkdirSync(join(base, "deep", "nested"), { recursive: true });
        const result = validatePath(join(base, "deep/nested/new.txt"), base);
        expect(result.ok).toBe(true);
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    });

    test("blocks write path with missing intermediate directory (TOCTOU defense)", () => {
      // Without this guard, a concurrent actor could create the missing
      // intermediate as a symlink to an outside directory between validation
      // and the caller's write. mkdir -p the parent before validating.
      const base = mkdtempSync(join(tmpdir(), "koi-pv-miss-"));
      try {
        const result = validatePath(join(base, "deep/nested/new.txt"), base);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.category).toBe("path-traversal");
          expect(result.reason).toMatch(/parent|missing/i);
        }
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    });
  });

  describe("missing / invalid base directory (round 7)", () => {
    test("missing base directory is rejected outright", () => {
      // Without this guard, a caller could pass a not-yet-existing base and a
      // path identical to it, and containment would pass against a root that
      // an attacker later materializes as a symlink outside the workspace.
      const missingBase = join(tmpdir(), `koi-pv-missing-${Date.now()}`);
      const result = validatePath(missingBase, missingBase);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.category).toBe("path-traversal");
        expect(result.reason).toMatch(/base.*missing|must exist/i);
      }
    });

    test("missing base directory rejects relative paths too", () => {
      const missingBase = join(tmpdir(), `koi-pv-missing2-${Date.now()}`);
      const result = validatePath(".", missingBase);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.category).toBe("path-traversal");
    });

    test("base pointing at a file (not a directory) is rejected", () => {
      const baseDir = mkdtempSync(join(tmpdir(), "koi-pv-notdir-"));
      try {
        const filePath = join(baseDir, "not-a-dir.txt");
        writeFileSync(filePath, "content");
        const result = validatePath("child", filePath);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.category).toBe("path-traversal");
          expect(result.reason).toMatch(/not a directory/i);
        }
      } finally {
        rmSync(baseDir, { recursive: true, force: true });
      }
    });
  });

  describe("mixed URL-encoded traversal (round 9)", () => {
    test("%2e./etc/passwd is rejected", () => {
      const result = validatePath("%2e./etc/passwd");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.category).toBe("path-traversal");
    });

    test(".%2e/etc/passwd is rejected", () => {
      const result = validatePath(".%2e/etc/passwd");
      expect(result.ok).toBe(false);
    });

    test("%252e./etc/passwd is rejected (double-encoded)", () => {
      const result = validatePath("%252e./etc/passwd");
      expect(result.ok).toBe(false);
    });

    test(".%252e/etc is rejected (mixed literal + double-encoded)", () => {
      const result = validatePath(".%252e/etc");
      expect(result.ok).toBe(false);
    });

    test("%2e.%2fetc is rejected (encoded dot + encoded slash)", () => {
      const result = validatePath("%2e.%2fetc");
      expect(result.ok).toBe(false);
    });

    test("uppercase %2E. is rejected (case-insensitive)", () => {
      const result = validatePath("%2E./etc/passwd");
      expect(result.ok).toBe(false);
    });
  });

  describe("literal dot + encoded separator (round 10)", () => {
    test("..%2fetc/passwd is rejected", () => {
      expect(validatePath("..%2fetc/passwd").ok).toBe(false);
    });

    test("..%5cetc is rejected (encoded backslash)", () => {
      expect(validatePath("..%5cetc").ok).toBe(false);
    });

    test("..%252fetc/passwd is rejected (double-encoded slash)", () => {
      expect(validatePath("..%252fetc/passwd").ok).toBe(false);
    });

    test("..%255cetc is rejected (double-encoded backslash)", () => {
      expect(validatePath("..%255cetc").ok).toBe(false);
    });

    test("uppercase ..%2F is rejected (case-insensitive)", () => {
      expect(validatePath("..%2Fetc").ok).toBe(false);
    });
  });

  describe("iterative URL-decode traversal (round 11)", () => {
    test("%252e.%252fetc/passwd is rejected (mixed double/literal)", () => {
      expect(validatePath("%252e.%252fetc/passwd").ok).toBe(false);
    });

    test(".%252e%252fetc is rejected (literal + double-encoded)", () => {
      expect(validatePath(".%252e%252fetc").ok).toBe(false);
    });

    test("%252e%2e%252fetc is rejected (triple-mixed)", () => {
      expect(validatePath("%252e%2e%252fetc").ok).toBe(false);
    });

    test("%25252e%25252e%25252fetc (triple-encoded) is rejected", () => {
      expect(validatePath("%25252e%25252e%25252fetc").ok).toBe(false);
    });
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
