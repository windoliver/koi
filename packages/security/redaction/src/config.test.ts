import { describe, expect, test } from "bun:test";
import { DEFAULT_REDACTION_CONFIG, validateRedactionConfig } from "./config.js";
import { createAllSecretPatterns } from "./patterns/index.js";
import type { RedactionConfig, SecretPattern } from "./types.js";

describe("validateRedactionConfig", () => {
  test("returns defaults for undefined config", () => {
    const result = validateRedactionConfig(undefined);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.maxDepth).toBe(10);
      expect(result.value.maxStringLength).toBe(100_000);
      expect(result.value.censor).toBe("redact");
      expect(result.value.patterns.length).toBe(13);
    }
  });

  test("returns defaults for empty object", () => {
    const result = validateRedactionConfig({});
    expect(result.ok).toBe(true);
  });

  test("rejects invalid maxDepth", () => {
    const result = validateRedactionConfig({ maxDepth: -1 });
    expect(result.ok).toBe(false);
  });

  test("rejects invalid maxStringLength", () => {
    const result = validateRedactionConfig({ maxStringLength: 0 });
    expect(result.ok).toBe(false);
  });

  test("rejects invalid censor", () => {
    // Runtime validation for untrusted input (e.g., parsed from YAML)
    const result = validateRedactionConfig({
      censor: "invalid",
    } as unknown as Partial<RedactionConfig>);
    expect(result.ok).toBe(false);
  });

  test("rejects invalid fieldCensor", () => {
    // Runtime validation for untrusted input
    const result = validateRedactionConfig({
      fieldCensor: 42,
    } as unknown as Partial<RedactionConfig>);
    expect(result.ok).toBe(false);
  });

  test("accepts valid partial config", () => {
    const result = validateRedactionConfig({
      maxDepth: 5,
      censor: "mask",
      fieldNames: ["secret"],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.maxDepth).toBe(5);
      expect(result.value.censor).toBe("mask");
      expect(result.value.fieldNames).toEqual(["secret"]);
    }
  });

  test("accepts custom censor function", () => {
    const result = validateRedactionConfig({
      censor: () => "***",
    });
    expect(result.ok).toBe(true);
  });

  test("rejects slow pattern in customPatterns", () => {
    const result = validateRedactionConfig({
      customPatterns: [
        {
          name: "slow-custom",
          kind: "slow",
          detect: (_text: string) => {
            // Simulate a pattern that takes too long (>5ms threshold)
            const end = performance.now() + 10;
            while (performance.now() < end) {
              /* busy-wait */
            }
            return [];
          },
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("slow-custom");
      expect(result.error.message).toContain("ReDoS");
    }
  });

  test("rejects slow pattern in patterns override", () => {
    const result = validateRedactionConfig({
      patterns: [
        {
          name: "slow-override",
          kind: "slow",
          detect: (_text: string) => {
            const end = performance.now() + 10;
            while (performance.now() < end) {
              /* busy-wait */
            }
            return [];
          },
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("slow-override");
      expect(result.error.message).toContain("ReDoS");
    }
  });

  test("skips ReDoS check on default patterns (trusted)", () => {
    // Default patterns should always pass — they are curated built-ins
    const result = validateRedactionConfig({});
    expect(result.ok).toBe(true);
  });

  test("accepts factory-created patterns passed as patterns override", () => {
    // Callers who rebuild/subset built-ins via createAllSecretPatterns()
    // should not be rejected by the timing check
    const builtins = createAllSecretPatterns();
    const result = validateRedactionConfig({
      patterns: builtins,
    });
    expect(result.ok).toBe(true);
  });

  test("accepts subset of factory-created patterns as override", () => {
    const builtins = createAllSecretPatterns();
    const result = validateRedactionConfig({
      // biome-ignore lint/style/noNonNullAssertion: createAllSecretPatterns always returns ≥2 entries
      patterns: [builtins[0]!, builtins[1]!],
    });
    expect(result.ok).toBe(true);
  });

  test("accepts safe user-supplied patterns override", () => {
    const result = validateRedactionConfig({
      patterns: [
        {
          name: "safe",
          kind: "safe",
          detect: () => [],
        },
      ],
    });
    expect(result.ok).toBe(true);
  });
});

describe("DEFAULT_REDACTION_CONFIG", () => {
  test("has 13 patterns", () => {
    expect(DEFAULT_REDACTION_CONFIG.patterns.length).toBe(13);
  });

  test("has default sensitive fields", () => {
    expect(DEFAULT_REDACTION_CONFIG.fieldNames.length).toBeGreaterThan(20);
  });

  test("uses redact censor", () => {
    expect(DEFAULT_REDACTION_CONFIG.censor).toBe("redact");
  });

  test("config object is frozen — cannot swap fields to poison defaults", () => {
    expect(Object.isFrozen(DEFAULT_REDACTION_CONFIG)).toBe(true);
    expect(() => {
      (DEFAULT_REDACTION_CONFIG as { censor: unknown }).censor = "mask";
    }).toThrow();
  });

  test("patterns array is frozen — cannot replace entries to poison process-wide", () => {
    // Regression for #1495: without this freeze a caller could mutate
    // DEFAULT_REDACTION_CONFIG.patterns[0] to a slow/throwing detector and
    // every future createRedactor() that relied on defaults would ship it.
    expect(Object.isFrozen(DEFAULT_REDACTION_CONFIG.patterns)).toBe(true);
    const evil: SecretPattern = { name: "evil", kind: "evil", detect: () => [] };
    expect(() => {
      (DEFAULT_REDACTION_CONFIG.patterns as SecretPattern[])[0] = evil;
    }).toThrow();
  });
});

describe("validateRedactionConfig — branding bypass regression (#1495)", () => {
  test("fake pattern with forged trust symbols is still ReDoS-probed", () => {
    // An attacker can enumerate symbols on a built-in (yields none with the
    // WeakSet-based registry, but historically leaked the trust symbol) and
    // re-attach them to a hostile object. The probe must still run.
    const fake: SecretPattern = {
      name: "forged",
      kind: "forged",
      detect: (_text: string) => {
        const end = performance.now() + 10;
        while (performance.now() < end) {
          /* busy-wait to trip the ReDoS threshold */
        }
        return [];
      },
    };
    // Stamp arbitrary-looking trust symbols — must not grant trust.
    Object.defineProperty(fake, Symbol("koi.redaction.trusted"), { value: true });
    Object.defineProperty(fake, Symbol.for("koi.redaction.trusted"), { value: true });

    const result = validateRedactionConfig({ patterns: [fake] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("forged");
      expect(result.error.message).toContain("ReDoS");
    }
  });

  test("detector that throws unconditionally during probe is rejected", () => {
    // Reviewer-requested regression: throw-during-probe must fail validation,
    // not be deferred to runtime (which would turn every redact call into
    // [REDACTION_FAILED]).
    const result = validateRedactionConfig({
      patterns: [
        {
          name: "thrower",
          kind: "boom",
          detect: (_text: string) => {
            throw new Error("detector crash");
          },
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("thrower");
      expect(result.error.message).toContain("exception");
    }
  });
});
