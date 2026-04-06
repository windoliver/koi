import { describe, expect, test } from "bun:test";
import { createRedactor } from "./redactor.js";

describe("createRedactor", () => {
  test("creates a redactor with default config", () => {
    const r = createRedactor();
    expect(r.redactObject).toBeDefined();
    expect(r.redactString).toBeDefined();
  });

  test("throws on invalid config", () => {
    expect(() => createRedactor({ maxDepth: -1 })).toThrow("Invalid redaction config");
  });

  test("redactor is frozen", () => {
    const r = createRedactor();
    expect(Object.isFrozen(r)).toBe(true);
  });

  test("getter-backed detect cannot return different function to probe vs runtime (#1495)", () => {
    // Regression: a caller supplies a getter that returns a benign detect to
    // the ReDoS probe, and a slow/throwing detect to the runtime. The validator
    // must snapshot `detect` by value so both the probe and the redactor see
    // the SAME captured function.
    let readCount = 0;
    const benign = (_text: string) => [];
    const hostile = (_text: string) => {
      throw new Error("should never reach runtime");
    };
    const pattern: { name: string; kind: string; readonly detect: typeof benign } = {
      name: "getter",
      kind: "getter",
      get detect() {
        readCount++;
        // First read (validator snapshot) is benign; later reads are hostile.
        return readCount === 1 ? benign : hostile;
      },
    };
    const r = createRedactor({ patterns: [pattern] });
    const result = r.redactString("hello");
    expect(result.matchCount).not.toBe(-1);
    expect(result.text).toBe("hello");
  });

  test("mutating DEFAULT_SENSITIVE_FIELDS cannot disable default field redaction (#1495)", async () => {
    // Regression: the default sensitive-field list must be frozen, otherwise
    // a module-reachable mutation like `DEFAULT_SENSITIVE_FIELDS.length = 0`
    // can disable redaction process-wide.
    const { DEFAULT_SENSITIVE_FIELDS } = await import("./patterns/index.js");
    expect(Object.isFrozen(DEFAULT_SENSITIVE_FIELDS)).toBe(true);
    expect(() => {
      (DEFAULT_SENSITIVE_FIELDS as string[]).length = 0;
    }).toThrow();

    // Default redactor still redacts sensitive fields.
    const r = createRedactor();
    const out = r.redactObject({ password: "hunter2" });
    expect(out.fieldCount).toBeGreaterThanOrEqual(1);
  });

  test("redactor does not retain references to caller-visible trusted patterns (#1495)", async () => {
    // Defense-in-depth: even if a future change broke markTrusted's freeze
    // guarantee, the redactor should not execute mutated built-in detectors.
    // We verify by pre-computing a redaction baseline, then attempting to
    // mutate each built-in and confirming the baseline output is unchanged.
    const { createAllSecretPatterns } = await import("./patterns/index.js");
    const builtins = createAllSecretPatterns();
    const r = createRedactor();
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.abc";
    const baseline = r.redactString(`t: ${jwt}`);
    expect(baseline.changed).toBe(true);

    // Attempt mutation (expected to throw, but even if it didn't the redactor
    // holds an internal snapshot and would ignore it).
    for (const p of builtins) {
      try {
        (p as { detect: unknown }).detect = () => [];
      } catch {
        /* frozen — expected */
      }
    }
    const after = r.redactString(`t: ${jwt}`);
    expect(after.text).toBe(baseline.text);
  });

  test("class-based detector relying on fields beyond name/kind is rejected at validation", () => {
    // Threat-model boundary: custom detectors run with the frozen snapshot
    // as `this`, so `this.regex`/`this.config` are undefined. A class-based
    // detector that reads extra receiver state throws at probe time and is
    // rejected cleanly — instead of silently passing validation and then
    // carrying live caller-owned state into the runtime.
    class MyDetector {
      public readonly name = "class-based";
      public readonly kind = "demo";
      private readonly regex = /SECRET-[A-Z0-9]{10}/g;
      detect(text: string) {
        this.regex.lastIndex = 0;
        const m = this.regex.exec(text);
        return m
          ? [{ text: m[0], start: m.index, end: m.index + m[0].length, kind: this.kind }]
          : [];
      }
    }
    expect(() => createRedactor({ patterns: [new MyDetector()] })).toThrow(
      "Invalid redaction config",
    );
  });

  test("stateless function-style custom detector redacts correctly", () => {
    // The supported path for custom detectors: a plain function closure.
    const regex = /SECRET-[A-Z0-9]{10}/g;
    const r = createRedactor({
      patterns: [
        {
          name: "stateless",
          kind: "demo",
          detect(text: string) {
            regex.lastIndex = 0;
            const m = regex.exec(text);
            return m
              ? [{ text: m[0], start: m.index, end: m.index + m[0].length, kind: "demo" }]
              : [];
          },
        },
      ],
    });
    const result = r.redactString("here is SECRET-ABCDEF1234 in text");
    expect(result.changed).toBe(true);
    expect(result.matchCount).toBe(1);
    expect(result.text).not.toContain("SECRET-ABCDEF1234");
  });

  test("post-validation pattern mutation cannot hijack the redactor (#1495)", () => {
    // Regression: caller passes validation with a benign detect, then swaps
    // pattern.detect AFTER createRedactor(). The redactor must use the
    // snapshot it captured at construction, not pick up the mutated function.
    const userPattern = {
      name: "toggle",
      kind: "toggle",
      detect: (_text: string) => [],
    };
    const r = createRedactor({ patterns: [userPattern] });

    // Attacker swaps detect to a throwing / slow impl.
    userPattern.detect = (_text: string) => {
      throw new Error("should not run — redactor must hold a snapshot");
    };

    // Redactor ignores the mutation and runs cleanly.
    const result = r.redactString("hello world");
    expect(result.matchCount).not.toBe(-1);
    expect(result.text).toBe("hello world");
  });

  test("redactString detects JWT", () => {
    const r = createRedactor();
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123";
    const result = r.redactString(`token: ${jwt}`);
    expect(result.changed).toBe(true);
    expect(result.text).not.toContain("eyJ");
  });

  test("redactString returns identity for clean text", () => {
    const r = createRedactor();
    const result = r.redactString("Hello, world!");
    expect(result.changed).toBe(false);
    expect(result.text).toBe("Hello, world!");
  });

  test("redactObject redacts field names", () => {
    const r = createRedactor();
    const result = r.redactObject({ username: "alice", password: "s3cret!" });
    expect(result.changed).toBe(true);
    const v = result.value as Record<string, string>;
    expect(v.username).toBe("alice");
    expect(v.password).toBe("[REDACTED]");
    expect(result.fieldCount).toBe(1);
  });

  test("redactObject redacts secrets in values", () => {
    const r = createRedactor();
    const result = r.redactObject({ data: "key=AKIAIOSFODNN7EXAMPLE" });
    expect(result.changed).toBe(true);
    expect(result.secretCount).toBe(1);
  });

  test("config-time rejection: pattern that throws on probe inputs is rejected", () => {
    // A detector that always throws is rejected at config time (not at runtime).
    // This prevents the trivial bypass: throw on known probe inputs, hang on real traffic.
    const errors: unknown[] = [];
    expect(() =>
      createRedactor({
        onError: (e) => errors.push(e),
        patterns: [
          {
            name: "boom",
            kind: "boom",
            detect() {
              throw new Error("detector crash");
            },
          },
        ],
      }),
    ).toThrow("Invalid redaction config");
    // onError also called with the validation failure
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });

  test("fail-closed on redactObject error at runtime (probe-passing but real-input-crashing pattern)", () => {
    // A pattern that passes probes but crashes on actual real-world inputs
    // still triggers fail-closed at redaction time.
    const probeInputs = new Set([
      "a".repeat(50),
      "a]a]a]a]a]a]a]a]a]a]".repeat(5),
      `-----BEGIN a PRIVATE KEY-----${"x".repeat(50)}`,
      `eyJ${".".repeat(50)}`,
    ]);
    const errors: unknown[] = [];
    const r = createRedactor({
      onError: (e) => errors.push(e),
      patterns: [
        {
          name: "runtime-boom",
          kind: "runtime-boom",
          detect(input: string) {
            // Passes probes, crashes on everything else
            if (probeInputs.has(input)) return [];
            throw new Error("runtime crash on real input");
          },
        },
      ],
    });
    const result = r.redactObject({ data: "test" });
    expect(result.changed).toBe(true);
    expect(result.value as unknown).toBe("[REDACTION_FAILED]");
    expect(result.secretCount).toBe(-1);
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });

  test("fail-closed on redactString error at runtime (probe-passing pattern)", () => {
    const probeInputs = new Set([
      "a".repeat(50),
      "a]a]a]a]a]a]a]a]a]a]".repeat(5),
      `-----BEGIN a PRIVATE KEY-----${"x".repeat(50)}`,
      `eyJ${".".repeat(50)}`,
    ]);
    const errors: unknown[] = [];
    const r = createRedactor({
      onError: (e) => errors.push(e),
      patterns: [
        {
          name: "runtime-boom",
          kind: "runtime-boom",
          detect(input: string) {
            if (probeInputs.has(input)) return [];
            throw new Error("runtime crash");
          },
        },
      ],
    });
    const result = r.redactString("actual-secret");
    expect(result.changed).toBe(true);
    expect(result.text).toBe("[REDACTION_FAILED]");
    expect(result.matchCount).toBe(-1);
  });

  test("accepts custom patterns", () => {
    const r = createRedactor({
      customPatterns: [
        {
          name: "custom_secret",
          kind: "custom",
          detect(text) {
            const idx = text.indexOf("SECRET_");
            if (idx < 0) return [];
            return [{ text: text.slice(idx, idx + 20), start: idx, end: idx + 20, kind: "custom" }];
          },
        },
      ],
    });
    const result = r.redactString("data=SECRET_abc123xyzxyz");
    expect(result.changed).toBe(true);
    expect(result.text).toContain("[REDACTED]");
  });

  test("accepts custom censor function", () => {
    const r = createRedactor({
      censor: (match) => `<${match.kind}>`,
    });
    const result = r.redactString("key=AKIAIOSFODNN7EXAMPLE");
    expect(result.changed).toBe(true);
    expect(result.text).toContain("<aws_access_key>");
  });
});
