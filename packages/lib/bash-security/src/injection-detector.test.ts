import { describe, expect, test } from "bun:test";
import { INJECTION_BYPASS_CASES, SAFE_CASES } from "./bypass-cases.js";
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

    test("BUG regression: package name containing 'source' must not match source-command pattern", () => {
      // `\bsource\b` matched `source-map`, `source-code-pro`, etc. because
      // hyphen is a word boundary. Tighten to require command position.
      expect(detectInjection("bun add source-map").ok).toBe(true);
      expect(detectInjection("npm install source-map-support").ok).toBe(true);
      expect(detectInjection("grep --source foo file").ok).toBe(true);
    });

    test("still blocks source at command position", () => {
      expect(detectInjection("source /tmp/evil.sh").ok).toBe(false);
      expect(detectInjection("echo ok; source /tmp/evil.sh").ok).toBe(false);
      expect(detectInjection("  source /tmp/evil.sh").ok).toBe(false);
    });

    test("BUG regression: source inside subshell must block", () => {
      expect(detectInjection("( source /tmp/evil.sh )").ok).toBe(false);
    });

    test("BUG regression: source inside command substitution must block", () => {
      expect(detectInjection("$(source /tmp/evil.sh)").ok).toBe(false);
    });

    test("BUG regression: source after reserved word (if) must block", () => {
      expect(detectInjection("if source /tmp/evil.sh; then :; fi").ok).toBe(false);
    });

    test("BUG regression: source after ! negation must block", () => {
      expect(detectInjection("! source /tmp/evil.sh").ok).toBe(false);
    });

    test("BUG regression: source inside brace group must block", () => {
      expect(detectInjection("{ source /tmp/evil.sh; }").ok).toBe(false);
    });
  });

  describe("input-length guard (ReDoS defense)", () => {
    test("oversize input is rejected with length diagnostic", () => {
      const input = "a".repeat(10000);
      const result = detectInjection(input);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.category).toBe("injection");
        expect(result.reason).toMatch(/exceeds .* chars/);
      }
    });
  });

  describe("ANSI-C decoding coverage (round 3)", () => {
    test("$'\\101' (octal escape for 'A') decodes through normalizer", () => {
      // Raw input contains $' with escape — raw-obfuscation pattern fires first.
      expect(detectInjection("$'\\101'").ok).toBe(false);
    });

    test("letter-escape $'\\n' inside content — raw-obfuscation does not fire", () => {
      // \n is in the letter map but not in the obfuscation regex (which targets hex/octal).
      // The decoded newline then passes matchPatterns without tripping any pattern.
      expect(detectInjection("echo $'\\n'").ok).toBe(true);
    });

    test("unterminated $'...' (malformed — findClosingQuote returns -1)", () => {
      // No closing quote; the $ is emitted as-is, then ' is stripped as ordinary quote.
      // Should not crash and should not match anything dangerous.
      expect(detectInjection("echo $'no-end").ok).toBe(true);
    });

    test('locale-translated $"..." strips the $ and quotes', () => {
      // $"foo" → foo (no match)
      expect(detectInjection('echo $"hello world"').ok).toBe(true);
    });
  });

  describe("unicode obfuscation normalization", () => {
    test("BUG regression: fullwidth Latin bypasses regex unless normalized", () => {
      // "ｒｍ" is fullwidth r + fullwidth m. Without NFKC normalization,
      // \brm\b and friends never match — attacker smuggles dangerous commands
      // by using fullwidth forms the shell still executes.
      expect(detectInjection("ｅｖａｌ $(whoami)").ok).toBe(false);
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

  describe("source/. with adjacent expansion (round 9)", () => {
    test("source$IFS/tmp/evil.sh is rejected (no space, adjacent $)", () => {
      expect(detectInjection("source$IFS/tmp/evil.sh").ok).toBe(false);
    });

    test("dot with brace-expansion IFS is rejected", () => {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal bash ${VAR}
      expect(detectInjection(".${IFS}/tmp/evil.sh").ok).toBe(false);
    });

    test("source`echo /tmp/evil.sh` is rejected (backtick expansion)", () => {
      expect(detectInjection("source`echo /tmp/evil.sh`").ok).toBe(false);
    });

    test("source$(echo /tmp/evil.sh) is rejected (command substitution)", () => {
      expect(detectInjection("source$(echo /tmp/evil.sh)").ok).toBe(false);
    });
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
