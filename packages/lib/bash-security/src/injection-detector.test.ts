import { describe, expect, test } from "bun:test";
import { INJECTION_BYPASS_CASES, SAFE_CASES } from "./__tests__/bypass-cases.js";
import { detectInjection } from "./injection-detector.js";

describe("detectInjection", () => {
  describe("blocks eval variants", () => {
    test("standalone eval", () => {
      const result = detectInjection("eval whoami");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.category).toBe("injection");
    });

    test("eval with subshell", () => {
      const result = detectInjection("eval $(cat /etc/passwd)");
      expect(result.ok).toBe(false);
    });

    test("eval in pipeline", () => {
      const result = detectInjection("echo 'cmd' | eval");
      expect(result.ok).toBe(false);
    });
  });

  describe("blocks source / dot-command", () => {
    test("source command", () => {
      expect(detectInjection("source /tmp/evil.sh").ok).toBe(false);
    });

    test("dot-command with space", () => {
      expect(detectInjection(". /tmp/evil.sh").ok).toBe(false);
    });

    // Regression: multiline payload ". script" after a newline bypassed the
    // original regex which only checked ^, ;, |, & as boundaries.
    test("dot-command after newline (multiline bypass)", () => {
      expect(detectInjection("echo ok\n. /tmp/evil.sh").ok).toBe(false);
    });

    test("dot-command after newline with leading whitespace", () => {
      expect(detectInjection("ls\n  . /tmp/evil.sh").ok).toBe(false);
    });

    // Regression: "  . /tmp/evil.sh" (leading spaces at start of input, no prior
    // command) bypassed the original `^` anchor because `^` requires position 0.
    // Fixed by changing `^` to `^\s*` so leading whitespace is allowed.
    test("dot-command with leading whitespace at start of input", () => {
      expect(detectInjection("  . /tmp/evil.sh").ok).toBe(false);
    });
  });

  describe("blocks base64 decode pipelines", () => {
    test("base64 -d | bash", () => {
      const result = detectInjection('echo "cm0gLXJm" | base64 -d | bash');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.category).toBe("injection");
        expect(result.reason).toMatch(/base64/);
      }
    });

    test("base64 --decode | sh", () => {
      expect(detectInjection("echo cm0gLXJm | base64 --decode | sh").ok).toBe(false);
    });
  });

  describe("blocks hex/octal ANSI-C strings", () => {
    test("hex-escaped string", () => {
      const result = detectInjection("$'\\x72\\x6d\\x20\\x2d\\x72\\x66'");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.category).toBe("injection");
    });

    test("octal-escaped string", () => {
      expect(detectInjection("$'\\114\\123\\040'").ok).toBe(false);
    });
  });

  describe("blocks null byte injection", () => {
    test("null byte in command", () => {
      expect(detectInjection("ls\x00; rm -rf /").ok).toBe(false);
    });
  });

  describe("blocks unicode escape obfuscation", () => {
    test("unicode escape sequence", () => {
      expect(detectInjection("\\u0072\\u006d\\u0020\\u002d\\u0072\\u0066").ok).toBe(false);
    });
  });

  describe("allows safe commands", () => {
    const safeCases = SAFE_CASES.filter((c) => c.classifier === "any");
    for (const { input, description } of safeCases) {
      test(description, () => {
        expect(detectInjection(input).ok).toBe(true);
      });
    }
  });

  describe("does not false-positive on common shell features", () => {
    test("command substitution in echo", () => {
      // $() is intentionally NOT blocked by injection-detector (see bash-classifier)
      expect(detectInjection("echo $(date)").ok).toBe(true);
    });

    test("subshell grouping", () => {
      expect(detectInjection("(cd /tmp && ls)").ok).toBe(true);
    });
  });

  describe("bypass case coverage", () => {
    for (const { input, shouldBlock, description } of INJECTION_BYPASS_CASES) {
      test(`${shouldBlock ? "blocks" : "allows"}: ${description}`, () => {
        const result = detectInjection(input);
        expect(result.ok).toBe(!shouldBlock);
      });
    }
  });

  describe("ClassificationResult shape", () => {
    test("blocked result has all required fields", () => {
      const result = detectInjection("eval bad");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(typeof result.reason).toBe("string");
        expect(result.reason.length).toBeGreaterThan(0);
        expect(typeof result.pattern).toBe("string");
        expect(result.pattern.length).toBeGreaterThan(0);
        expect(result.category).toBeDefined();
      }
    });

    test("allowed result has only ok:true", () => {
      const result = detectInjection("git status");
      expect(result).toEqual({ ok: true });
    });
  });
});
