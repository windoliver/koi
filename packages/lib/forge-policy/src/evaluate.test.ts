import { describe, expect, test } from "bun:test";
import { makeCandidate, makeConfig } from "./__tests__/fixtures.js";
import { evaluatePolicy } from "./evaluate.js";

describe("evaluatePolicy — required gating cases (issue #1349)", () => {
  test("rejects over-complex artifact via maxComplexity ceiling", () => {
    const cfg = makeConfig({ maxComplexity: 10 });
    const candidate = makeCandidate();
    const huge = { body: "x".repeat(500) };

    const { verdict } = evaluatePolicy(candidate, cfg, { spec: huge });

    expect(verdict.decision).toBe("deny");
    if (verdict.decision === "deny") {
      expect(verdict.reason).toMatch(/complex/i);
    }
  });

  test("allows when complexity is within ceiling", () => {
    const cfg = makeConfig({ maxComplexity: 10_000 });
    const { verdict } = evaluatePolicy(makeCandidate(), cfg, { spec: { x: 1 } });
    expect(verdict.decision).toBe("allow");
  });

  test("allowed capabilities — denies kinds outside allowedKinds", () => {
    const cfg = makeConfig({ allowedKinds: ["tool"] });
    const candidate = makeCandidate({ kind: "channel" });

    const { verdict } = evaluatePolicy(candidate, cfg);

    expect(verdict.decision).toBe("deny");
    if (verdict.decision === "deny") {
      expect(verdict.reason).toMatch(/channel|allowed/i);
    }
  });

  test("namespace restrictions block forbidden name prefixes", () => {
    const cfg = makeConfig({ forbiddenNamespaces: ["system.", "koi."] });
    const candidate = makeCandidate({ name: "system.exec" });

    const { verdict } = evaluatePolicy(candidate, cfg);

    expect(verdict.decision).toBe("deny");
    if (verdict.decision === "deny") {
      expect(verdict.reason).toMatch(/system\./);
    }
  });

  test("namespace check is case-sensitive prefix match", () => {
    const cfg = makeConfig({ forbiddenNamespaces: ["System."] });
    const ok = evaluatePolicy(makeCandidate({ name: "system.exec" }), cfg);
    expect(ok.verdict.decision).toBe("allow");
    const bad = evaluatePolicy(makeCandidate({ name: "System.exec" }), cfg);
    expect(bad.verdict.decision).toBe("deny");
  });

  test("policy override requires explicit granted flag — without it, deny stands", () => {
    const cfg = makeConfig({ allowedKinds: ["tool"] });
    const candidate = makeCandidate({ kind: "channel" });

    const denyNoOverride = evaluatePolicy(candidate, cfg);
    expect(denyNoOverride.verdict.decision).toBe("deny");
    expect(denyNoOverride.overrideApplied).toBe(false);

    const denyWithUngrantedOverride = evaluatePolicy(candidate, cfg, {
      override: { granted: false, reason: "n/a", grantedBy: "op-1" },
    });
    expect(denyWithUngrantedOverride.verdict.decision).toBe("deny");
    expect(denyWithUngrantedOverride.overrideApplied).toBe(false);

    const allowWithGrantedOverride = evaluatePolicy(candidate, cfg, {
      override: { granted: true, reason: "ops emergency #42", grantedBy: "op-1" },
    });
    expect(allowWithGrantedOverride.verdict.decision).toBe("allow");
    expect(allowWithGrantedOverride.overrideApplied).toBe(true);
    expect(allowWithGrantedOverride.baseVerdict.decision).toBe("deny");
  });

  test("override cannot tighten an already-allow verdict", () => {
    const cfg = makeConfig();
    const candidate = makeCandidate();
    const result = evaluatePolicy(candidate, cfg, {
      override: { granted: true, reason: "noop", grantedBy: "op-1" },
    });
    expect(result.verdict.decision).toBe("allow");
    expect(result.overrideApplied).toBe(false);
  });
});

describe("evaluatePolicy — scope and approval", () => {
  test("denies candidates above maxScope", () => {
    const cfg = makeConfig({ maxScope: "agent" });
    const { verdict } = evaluatePolicy(makeCandidate({ proposedScope: "global" }), cfg);
    expect(verdict.decision).toBe("deny");
    if (verdict.decision === "deny") {
      expect(verdict.reason).toMatch(/scope/i);
    }
  });

  test("requires approval at or above the approval threshold", () => {
    const cfg = makeConfig({
      maxScope: "global",
      requireApprovalAtOrAbove: "zone",
    });
    const { verdict } = evaluatePolicy(makeCandidate({ proposedScope: "zone" }), cfg);
    expect(verdict.decision).toBe("require-approval");
  });
});

describe("evaluatePolicy — fail-closed cases", () => {
  test("denies when maxComplexity is configured but spec is absent", () => {
    const cfg = makeConfig({ maxComplexity: 100 });
    const { verdict } = evaluatePolicy(makeCandidate(), cfg);
    expect(verdict.decision).toBe("deny");
    if (verdict.decision === "deny") {
      expect(verdict.reason).toMatch(/spec.*required/i);
    }
  });

  test("allows when maxComplexity is unset and spec is absent", () => {
    const cfg = makeConfig();
    const { verdict } = evaluatePolicy(makeCandidate(), cfg);
    expect(verdict.decision).toBe("allow");
  });

  test("denies cyclic spec instead of crashing", () => {
    const cfg = makeConfig({ maxComplexity: 10_000 });
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    const { verdict } = evaluatePolicy(makeCandidate(), cfg, { spec: cyclic });
    expect(verdict.decision).toBe("deny");
    if (verdict.decision === "deny") {
      expect(verdict.reason).toMatch(/cycl|json/i);
    }
  });

  test("denies spec containing nested cycle", () => {
    const cfg = makeConfig({ maxComplexity: 10_000 });
    const inner: Record<string, unknown> = { x: 1 };
    const outer: Record<string, unknown> = { inner };
    inner.outer = outer;
    const { verdict } = evaluatePolicy(makeCandidate(), cfg, { spec: outer });
    expect(verdict.decision).toBe("deny");
  });

  test("denies spec containing BigInt (JSON.stringify throws on BigInt)", () => {
    const cfg = makeConfig({ maxComplexity: 10_000 });
    const { verdict } = evaluatePolicy(makeCandidate(), cfg, {
      spec: { v: BigInt(1) } as Readonly<Record<string, unknown>>,
    });
    expect(verdict.decision).toBe("deny");
  });

  test("complexityOf cannot bypass the cycle / non-JSON-safe spec guard", () => {
    const cfg = makeConfig({ maxComplexity: 10_000 });
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    const { verdict } = evaluatePolicy(makeCandidate(), cfg, {
      spec: cyclic,
      complexityOf: () => 1,
    });
    expect(verdict.decision).toBe("deny");
    if (verdict.decision === "deny") {
      expect(verdict.reason).toMatch(/cycl|json/i);
    }
  });

  test("complexityOf cannot bypass non-JSON-safe values (BigInt)", () => {
    const cfg = makeConfig({ maxComplexity: 10_000 });
    const { verdict } = evaluatePolicy(makeCandidate(), cfg, {
      spec: { v: BigInt(1) } as Readonly<Record<string, unknown>>,
      complexityOf: () => 0,
    });
    expect(verdict.decision).toBe("deny");
  });
});

describe("evaluatePolicy — JSON-stringify parity for soft cases", () => {
  test("undefined object properties are omitted, not rejected", () => {
    const cfg = makeConfig({ maxComplexity: 10_000 });
    const spec: Readonly<Record<string, unknown>> = {
      a: 1,
      b: undefined,
      c: "x",
    };
    const { verdict } = evaluatePolicy(makeCandidate(), cfg, { spec });
    expect(verdict.decision).toBe("allow");
  });

  test("score for spec with undefined property equals score without it", () => {
    const cfg = makeConfig({ maxComplexity: 10_000 });
    const withUndef = evaluatePolicy(makeCandidate(), cfg, {
      spec: { a: 1, missing: undefined } as Readonly<Record<string, unknown>>,
    });
    const without = evaluatePolicy(makeCandidate(), cfg, {
      spec: { a: 1 },
    });
    expect(withUndef.verdict).toEqual(without.verdict);
  });

  test("many undefined object properties charge per-key bytes (work bound)", () => {
    const cfg = makeConfig({ maxComplexity: 10 });
    const spec: Record<string, unknown> = {};
    for (let i = 0; i < 1_000; i++) spec[`empty${i}`] = undefined;
    spec["a"] = 1;
    // The budget is a *work* lower-bound, not strict canonical-JSON
    // byte parity: 1000 undefined keys cost ~6 bytes each → exceeds
    // the small operator-set budget. This is what blocks the
    // many-undefined-keys clone-amplification attack on the default
    // path. (A small handful of undefined keys still passes.)
    const { verdict } = evaluatePolicy(makeCandidate(), cfg, { spec });
    expect(verdict.decision).toBe("deny");
  });

  test("undefined array elements render as null (JSON-stringify behavior)", () => {
    const cfg = makeConfig({ maxComplexity: 10_000 });
    const spec: Readonly<Record<string, unknown>> = {
      items: [1, undefined, 3],
    };
    const { verdict } = evaluatePolicy(makeCandidate(), cfg, { spec });
    expect(verdict.decision).toBe("allow");
  });

  test("Date values are rejected — caller must pre-serialize", () => {
    const cfg = makeConfig({ maxComplexity: 10_000 });
    const { verdict } = evaluatePolicy(makeCandidate(), cfg, {
      spec: { ts: new Date("2020-01-01T00:00:00.000Z") } as Readonly<Record<string, unknown>>,
    });
    expect(verdict.decision).toBe("deny");
    if (verdict.decision === "deny") {
      expect(verdict.reason).toMatch(/plain|prototype|JSON/i);
    }
  });

  test("custom prototypes are rejected (Map, Set, class instance)", () => {
    const cfg = makeConfig({ maxComplexity: 10_000 });
    class Custom {
      x = 1;
    }
    for (const v of [new Map(), new Set(), new Custom()]) {
      const { verdict } = evaluatePolicy(makeCandidate(), cfg, {
        spec: { item: v } as Readonly<Record<string, unknown>>,
      });
      expect(verdict.decision).toBe("deny");
    }
  });

  test("sparse arrays preserve length — Array(N) holes are counted as null entries", () => {
    // JSON.stringify(Array(5000)) is 5000 `null` entries (~25KB). With a
    // small ceiling, this must deny rather than silently allowing the
    // attacker to hide a huge payload behind sparse-array holes.
    const cfg = makeConfig({ maxComplexity: 100 });
    const huge = new Array(5000);
    const { verdict } = evaluatePolicy(makeCandidate(), cfg, {
      spec: { items: huge } as Readonly<Record<string, unknown>>,
    });
    expect(verdict.decision).toBe("deny");
  });

  test("cumulative sparse-array bytes trigger early deny (no full canonicalize)", () => {
    // Each array stays under MAX_ARRAY_LENGTH (100k) but together their
    // lower-bound JSON size (~80k * 50 * 5 = 20MB) blows past a small
    // ceiling. Must deny without materializing the canonical string.
    const cfg = makeConfig({ maxComplexity: 1_000 });
    const spec: Record<string, unknown> = {};
    for (let i = 0; i < 50; i++) {
      const a: unknown[] = [];
      a.length = 80_000;
      spec[`a${i}`] = a;
    }
    const start = Date.now();
    const { verdict } = evaluatePolicy(makeCandidate(), cfg, { spec });
    const elapsed = Date.now() - start;
    expect(verdict.decision).toBe("deny");
    // If we were materializing the full ~20MB canonical string this
    // would be much slower. 1s is a generous upper bound.
    expect(elapsed).toBeLessThan(1000);
  });

  test("oversized arrays are rejected before allocation/serialization (DoS guard)", () => {
    const cfg = makeConfig({ maxComplexity: 10_000_000 });
    const huge: unknown[] = [];
    huge.length = 200_000; // above MAX_ARRAY_LENGTH (100k)
    const { verdict } = evaluatePolicy(makeCandidate(), cfg, {
      spec: { items: huge } as Readonly<Record<string, unknown>>,
    });
    expect(verdict.decision).toBe("deny");
    if (verdict.decision === "deny") {
      expect(verdict.reason).toMatch(/array length|MAX_ARRAY_LENGTH/);
    }
  });

  test("array with trailing holes is scored at full length", () => {
    const cfg = makeConfig({ maxComplexity: 50 });
    // [1, <hole>, <hole>, <hole>, <hole>] — JSON renders as [1,null,null,null,null]
    const arr: (number | undefined)[] = [];
    arr[0] = 1;
    arr.length = 5;
    const sized = evaluatePolicy(makeCandidate(), cfg, {
      spec: { items: arr } as Readonly<Record<string, unknown>>,
    });
    // length=5 of nulls -> "[1,null,null,null,null]" = 22 bytes wrapped,
    // well below 50 byte limit -> allow.
    expect(sized.verdict.decision).toBe("allow");
    // But length=500 of nulls would blow past 50.
    const bigArr: (number | undefined)[] = [];
    bigArr.length = 500;
    const denied = evaluatePolicy(makeCandidate(), cfg, {
      spec: { items: bigArr } as Readonly<Record<string, unknown>>,
    });
    expect(denied.verdict.decision).toBe("deny");
  });

  test("an own __proto__ key is counted in the score, not silently dropped", () => {
    const cfg = makeConfig({ maxComplexity: 50 });
    // Build an object with an own enumerable __proto__ key carrying a
    // large subtree. With a regular {} clone target this would hide the
    // payload via prototype assignment; the null-prototype clone keeps it
    // as data so the byte score reflects reality.
    const spec: Readonly<Record<string, unknown>> = JSON.parse(
      `{"__proto__": {"huge": "${"x".repeat(500)}"}, "safe": 1}`,
    );
    const { verdict } = evaluatePolicy(makeCandidate(), cfg, { spec });
    expect(verdict.decision).toBe("deny");
  });

  test("an own toJSON property denies — never invoked", () => {
    const cfg = makeConfig({ maxComplexity: 10_000 });
    const spec = {
      item: {
        junk: "y".repeat(100),
        toJSON: () => "x",
      },
    } as Readonly<Record<string, unknown>>;
    const { verdict } = evaluatePolicy(makeCandidate(), cfg, { spec });
    expect(verdict.decision).toBe("deny");
    if (verdict.decision === "deny") {
      expect(verdict.reason).toMatch(/toJSON/);
    }
  });

  test("an enumerable getter is rejected by descriptor — getter is NEVER invoked", () => {
    const cfg = makeConfig({ maxComplexity: 10_000 });
    let invoked = 0;
    const trap: Record<string, unknown> = { safe: 1 };
    Object.defineProperty(trap, "evil", {
      enumerable: true,
      get() {
        invoked++;
        throw new Error("boom");
      },
    });
    const { verdict } = evaluatePolicy(makeCandidate(), cfg, { spec: trap });
    expect(verdict.decision).toBe("deny");
    expect(invoked).toBe(0);
  });

  test("an indexed getter on an array slot is rejected without invocation", () => {
    const cfg = makeConfig({ maxComplexity: 10_000 });
    let invoked = 0;
    const arr: unknown[] = [];
    Object.defineProperty(arr, 0, {
      enumerable: true,
      get() {
        invoked++;
        throw new Error("array boom");
      },
    });
    const { verdict } = evaluatePolicy(makeCandidate(), cfg, {
      spec: { items: arr } as Readonly<Record<string, unknown>>,
    });
    expect(verdict.decision).toBe("deny");
    expect(invoked).toBe(0);
  });

  test("canonicalization uses the detached clone — Proxy get traps never fire after validation", () => {
    const cfg = makeConfig({ maxComplexity: 10_000 });
    let getCalls = 0;
    // Proxy presents a clean descriptor during validation, but its `get`
    // trap would fire if anyone reads through the proxy afterwards. The
    // detached-clone path means canonicalization never reads through it.
    const target = { x: 1 };
    const honest = new Proxy(target, {
      get(t, p, r) {
        getCalls++;
        return Reflect.get(t, p, r);
      },
    });
    const { verdict } = evaluatePolicy(makeCandidate(), cfg, {
      spec: { item: honest } as Readonly<Record<string, unknown>>,
    });
    // The proxy passes validation (proto is Object.prototype, no toJSON,
    // descriptor exposes a real `value`). Score is computed from the
    // clone, which means no `get` trap should fire during canonicalize.
    expect(verdict.decision).toBe("allow");
    expect(getCalls).toBe(0);
  });

  test("a Proxy whose trap throws degrades to deny instead of escaping", () => {
    const cfg = makeConfig({ maxComplexity: 10_000 });
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("ownKeys trap explodes");
        },
        getOwnPropertyDescriptor() {
          throw new Error("descriptor trap explodes");
        },
        getPrototypeOf() {
          throw new Error("proto trap explodes");
        },
      },
    );
    const { verdict } = evaluatePolicy(makeCandidate(), cfg, {
      spec: { item: hostile } as Readonly<Record<string, unknown>>,
    });
    expect(verdict.decision).toBe("deny");
    if (verdict.decision === "deny") {
      expect(verdict.reason).toMatch(/proxy|trap|inspection|plain/i);
    }
  });

  test("custom complexityOf path still enforces a structural budget against attacker amplification", () => {
    // 12MB-equivalent payload: 12k keys * (key + 1KB string) ~ above the
    // 10MB STRUCTURAL_BUDGET. Even with a tiny custom score, the gate
    // must deny early during validation.
    const cfg = makeConfig({ maxComplexity: 1 });
    const spec: Record<string, unknown> = {};
    for (let i = 0; i < 12_000; i++) spec[`k${i}`] = "x".repeat(1_000);
    const { verdict } = evaluatePolicy(makeCandidate(), cfg, {
      spec,
      complexityOf: () => 1,
    });
    expect(verdict.decision).toBe("deny");
  });

  test("dense undefined arrays are scored as null entries (not 0 bytes)", () => {
    // Array(80k).fill(undefined) -> JSON renders as 80k `null` entries
    // (~320KB). With a tight ceiling, validation must trip the budget
    // before clone/serialization.
    const cfg = makeConfig({ maxComplexity: 1_000 });
    const dense: (undefined | unknown)[] = new Array(80_000).fill(undefined);
    const { verdict } = evaluatePolicy(makeCandidate(), cfg, {
      // Wrap to keep individual array length under MAX_ARRAY_LENGTH cap.
      spec: { items: dense } as Readonly<Record<string, unknown>>,
    });
    expect(verdict.decision).toBe("deny");
  });

  test("complexityOf scorer can use Object.prototype methods (hasOwnProperty, toString)", () => {
    const cfg = makeConfig({ maxComplexity: 100 });
    const scorer = (s: Readonly<Record<string, unknown>>): number => {
      // Conventional scorer using Object.prototype methods — must work
      // even though the internal clone uses null-prototype.
      if (!Object.hasOwn(s, "a")) return 1000;
      return 1;
    };
    const { verdict } = evaluatePolicy(makeCandidate(), cfg, {
      spec: { a: 1 },
      complexityOf: scorer,
    });
    expect(verdict.decision).toBe("allow");
  });

  test("complexityOf scorer can use methods on the spec object directly", () => {
    const cfg = makeConfig({ maxComplexity: 100 });
    const scorer = (s: Readonly<Record<string, unknown>>): number => {
      // biome-ignore lint/suspicious/noPrototypeBuiltins: deliberate: test that scorer can call hasOwnProperty as a method
      return Object.hasOwn(
        s as Record<string, unknown> & { hasOwnProperty: (k: string) => boolean },
        "a",
      )
        ? 1
        : 1000;
    };
    const { verdict } = evaluatePolicy(makeCandidate(), cfg, {
      spec: { a: 1 },
      complexityOf: scorer,
    });
    expect(verdict.decision).toBe("allow");
  });

  test("custom complexityOf path denies escape-heavy payload above STRUCTURAL_BUDGET_BYTES", () => {
    // Payload of 12MB worth of quote/backslash characters. Each char
    // expands to 2 bytes in JSON (`\"` or `\\`), so the real serialized
    // size is ~24MB — far above the 10MB structural cap. Caller's tiny
    // `complexityOf` must NOT be able to bypass it.
    const big = '"\\'.repeat(6_000_000); // 12_000_000 chars → ~24MB JSON
    const cfg = makeConfig({ maxComplexity: 1 });
    const { verdict } = evaluatePolicy(makeCandidate(), cfg, {
      spec: { s: big },
      complexityOf: () => 1,
    });
    expect(verdict.decision).toBe("deny");
  });

  test("custom complexityOf path denies lone-surrogate payload above STRUCTURAL_BUDGET_BYTES", () => {
    // Lone high surrogate `\uD800` escapes as `\ud800` (6 ASCII bytes)
    // in JSON.stringify. 2M of them → ~12MB JSON, above the 10MB cap.
    // Earlier accounting treated lone surrogates as 3 bytes and would
    // have undercounted them.
    const lone = "\uD800".repeat(2_000_000);
    const cfg = makeConfig({ maxComplexity: 1 });
    const { verdict } = evaluatePolicy(makeCandidate(), cfg, {
      spec: { s: lone },
      complexityOf: () => 1,
    });
    expect(verdict.decision).toBe("deny");
  });

  test("paired surrogate pair charges 4 bytes (matches JSON.stringify)", () => {
    // Valid astral codepoint (😀 = U+1F600 = D83D DE00). Real UTF-8 size
    // is 4 bytes. A 2M-char (= 1M-codepoint) string serializes to ~4MB,
    // well under the 10MB cap → allow.
    const emoji = "😀".repeat(1_000_000);
    const cfg = makeConfig({ maxComplexity: 1 });
    const { verdict } = evaluatePolicy(makeCandidate(), cfg, {
      spec: { s: emoji },
      complexityOf: () => 1,
    });
    expect(verdict.decision).toBe("allow");
  });

  test("custom complexityOf path denies multi-byte unicode payload above STRUCTURAL_BUDGET_BYTES", () => {
    // 4MB of 4-byte UTF-8 chars (emoji) → ~16MB UTF-8 bytes, above 10MB.
    const emoji = "😀".repeat(4_000_000);
    const cfg = makeConfig({ maxComplexity: 1 });
    const { verdict } = evaluatePolicy(makeCandidate(), cfg, {
      spec: { s: emoji },
      complexityOf: () => 1,
    });
    expect(verdict.decision).toBe("deny");
  });

  test("custom complexityOf path denies numeric-heavy payload above STRUCTURAL_BUDGET_BYTES", () => {
    // 1M large-magnitude numbers, each ~17 chars in JSON form → ~17MB,
    // above the 10MB structural cap. Caller's tiny `complexityOf` must
    // not be able to bypass it via the old constant 1-byte-per-number
    // charge.
    const arr: number[] = new Array(1_000_000);
    for (let i = 0; i < arr.length; i++) arr[i] = 1.2345678901234567e100;
    const cfg = makeConfig({ maxComplexity: 1 });
    const { verdict } = evaluatePolicy(makeCandidate(), cfg, {
      spec: { a: arr },
      complexityOf: () => 1,
    });
    expect(verdict.decision).toBe("deny");
  });

  test("custom complexityOf materializes sparse-array holes as null (no Array.prototype fallthrough)", () => {
    // Pollute Array.prototype to simulate hostile ambient state.
    // Holes on the scorer-visible clone must NOT reach this value.
    type WithIdx = readonly unknown[] & { 0?: unknown };
    (Array.prototype as WithIdx)[0] = "POLLUTED";
    try {
      const arr: unknown[] = new Array(3);
      arr[2] = "x";
      let observedAt0: unknown;
      let isOwn0 = false;
      const cfg = makeConfig({ maxComplexity: 100 });
      const { verdict } = evaluatePolicy(makeCandidate(), cfg, {
        spec: { a: arr },
        complexityOf: (s) => {
          const a = (s as { a: unknown[] }).a;
          observedAt0 = a[0];
          isOwn0 = Object.hasOwn(a, 0);
          return 1;
        },
      });
      expect(verdict.decision).toBe("allow");
      expect(observedAt0).toBe(null);
      expect(isOwn0).toBe(true);
    } finally {
      delete (Array.prototype as { 0?: unknown })[0];
    }
  });

  test("default path denies many-undefined-keys clone-amplification (no complexityOf)", () => {
    // Default (canonical-byte) path with a small operator maxComplexity.
    // Spec has many own keys whose values are undefined — JSON.stringify
    // would yield `{}` (2 bytes), but the validator must charge per-key
    // bytes anyway so it can't be amplified.
    const spec: Record<string, unknown> = {};
    for (let i = 0; i < 1000; i++) spec[`k${i}`] = undefined;
    const cfg = makeConfig({ maxComplexity: 100 });
    const { verdict } = evaluatePolicy(makeCandidate(), cfg, { spec });
    expect(verdict.decision).toBe("deny");
  });

  test("custom complexityOf path denies many-undefined-keys clone-amplification attack", () => {
    // 5M own keys whose values are all `undefined`. JSON.stringify
    // omits them so the canonical byte count is `{}` (2 bytes), but
    // each key still costs validation+defineProperty work. The
    // structural cap must charge per-key bytes on this path so the
    // 10MB budget actually bounds clone effort.
    const spec: Record<string, unknown> = {};
    const keyPrefix = "k".repeat(50); // ~52 chars charged per key
    for (let i = 0; i < 250_000; i++) spec[`${keyPrefix}${i}`] = undefined;
    const cfg = makeConfig({ maxComplexity: 1 });
    const { verdict } = evaluatePolicy(makeCandidate(), cfg, {
      spec,
      complexityOf: () => 1,
    });
    expect(verdict.decision).toBe("deny");
  });

  test("custom complexityOf path skips canonicalization (no byte serialization cost)", () => {
    // A spec whose canonical JSON would be enormous, but the custom
    // scorer returns a constant tiny score. With canonicalize on the
    // custom path we'd OOM or blow the budget; with the short-circuit
    // we return allow quickly.
    const cfg = makeConfig({ maxComplexity: 10 });
    const spec: Record<string, unknown> = {};
    for (let i = 0; i < 1_000; i++) spec[`k${i}`] = "x".repeat(500);
    const start = Date.now();
    const { verdict } = evaluatePolicy(makeCandidate(), cfg, {
      spec,
      complexityOf: () => 1,
    });
    const elapsed = Date.now() - start;
    expect(verdict.decision).toBe("allow");
    // Tight bound: a JSON.stringify pass on this spec would be much slower.
    expect(elapsed).toBeLessThan(200);
  });

  test.each([
    ["leading zero", "01"],
    ["fractional", "1.0"],
    ["negative zero", "-0"],
    ["scientific", "1e1"],
    ["leading space", " 1"],
  ])("array key %s ('%s') is non-canonical and denies (JSON-parity)", (_label, key) => {
    const cfg = makeConfig({ maxComplexity: 10_000 });
    const arr: unknown[] = [];
    arr.length = 3;
    (arr as unknown as Record<string, unknown>)[key] = 999;
    const { verdict } = evaluatePolicy(makeCandidate(), cfg, {
      spec: { items: arr } as Readonly<Record<string, unknown>>,
    });
    expect(verdict.decision).toBe("deny");
  });

  test("non-enumerable array index data is counted (JSON.stringify still serializes it)", () => {
    const cfg = makeConfig({ maxComplexity: 30 });
    const arr: unknown[] = [];
    arr.length = 3;
    Object.defineProperty(arr, 0, {
      value: "x".repeat(200),
      enumerable: false,
      writable: true,
      configurable: true,
    });
    const { verdict } = evaluatePolicy(makeCandidate(), cfg, {
      spec: { items: arr } as Readonly<Record<string, unknown>>,
    });
    expect(verdict.decision).toBe("deny");
  });

  test("non-enumerable array index getter is rejected without invocation", () => {
    const cfg = makeConfig({ maxComplexity: 10_000 });
    let invoked = 0;
    const arr: unknown[] = [];
    arr.length = 1;
    Object.defineProperty(arr, 0, {
      enumerable: false,
      get() {
        invoked++;
        throw new Error("indexed boom");
      },
    });
    const { verdict } = evaluatePolicy(makeCandidate(), cfg, {
      spec: { items: arr } as Readonly<Record<string, unknown>>,
    });
    expect(verdict.decision).toBe("deny");
    expect(invoked).toBe(0);
  });

  test("array with a non-index enumerable own property is denied (JSON-mismatch)", () => {
    const cfg = makeConfig({ maxComplexity: 10_000 });
    const arr: unknown[] = [1, 2, 3];
    (arr as unknown as Record<string, unknown>)["meta"] = { secret: "x".repeat(500) };
    const { verdict } = evaluatePolicy(makeCandidate(), cfg, {
      spec: { items: arr } as Readonly<Record<string, unknown>>,
    });
    expect(verdict.decision).toBe("deny");
    if (verdict.decision === "deny") {
      expect(verdict.reason).toMatch(/non-index|JSON/i);
    }
  });

  test("complexityOf receives the detached clone — Proxy traps never fire on the scorer path", () => {
    const cfg = makeConfig({ maxComplexity: 1_000_000 });
    let getCalls = 0;
    const inner = new Proxy(
      { x: 1 },
      {
        get(t, p, r) {
          getCalls++;
          return Reflect.get(t, p, r);
        },
      },
    );
    const custom = (s: Readonly<Record<string, unknown>>): number => {
      // If `s` is the original spec, this read fires the proxy trap. With
      // the detached-clone fix it should be a plain object.
      const item = s["item"] as Readonly<Record<string, unknown>> | undefined;
      const x = item?.["x"];
      return typeof x === "number" ? x : 0;
    };
    evaluatePolicy(makeCandidate(), cfg, {
      spec: { item: inner } as Readonly<Record<string, unknown>>,
      complexityOf: custom,
    });
    expect(getCalls).toBe(0);
  });

  test("a throwing custom complexityOf denies instead of crashing the evaluator", () => {
    const cfg = makeConfig({ maxComplexity: 10 });
    const { verdict } = evaluatePolicy(makeCandidate(), cfg, {
      spec: { x: 1 },
      complexityOf: () => {
        throw new Error("scorer broken");
      },
    });
    expect(verdict.decision).toBe("deny");
    if (verdict.decision === "deny") {
      expect(verdict.reason).toMatch(/complexityOf|threw/i);
    }
  });

  test("function and symbol values are rejected (no lossy projection)", () => {
    const cfg = makeConfig({ maxComplexity: 10_000 });
    const fnDeny = evaluatePolicy(makeCandidate(), cfg, {
      spec: { fn: () => 1, x: 1 } as Readonly<Record<string, unknown>>,
    });
    expect(fnDeny.verdict.decision).toBe("deny");
    const symDeny = evaluatePolicy(makeCandidate(), cfg, {
      spec: { s: Symbol("x") } as Readonly<Record<string, unknown>>,
    });
    expect(symDeny.verdict.decision).toBe("deny");
  });
});

describe("evaluatePolicy — determinism and purity", () => {
  test("same inputs always produce the same verdict", () => {
    const cfg = makeConfig({ maxComplexity: 5 });
    const candidate = makeCandidate();
    const spec = { a: 1, b: 2 };
    const v1 = evaluatePolicy(candidate, cfg, { spec });
    const v2 = evaluatePolicy(candidate, cfg, { spec });
    expect(v1).toEqual(v2);
  });

  test("complexity score is order-independent for spec keys", () => {
    const cfg = makeConfig({ maxComplexity: 30 });
    const a = evaluatePolicy(makeCandidate(), cfg, { spec: { a: 1, b: 2 } });
    const b = evaluatePolicy(makeCandidate(), cfg, { spec: { b: 2, a: 1 } });
    expect(a.verdict.decision).toBe(b.verdict.decision);
  });

  test("custom complexityOf replaces default heuristic", () => {
    const cfg = makeConfig({ maxComplexity: 10 });
    const { verdict } = evaluatePolicy(makeCandidate(), cfg, {
      spec: { huge: "x".repeat(1000) },
      complexityOf: () => 1,
    });
    expect(verdict.decision).toBe("allow");
  });

  test("non-finite complexityOf result is treated as zero", () => {
    const cfg = makeConfig({ maxComplexity: 1 });
    const { verdict } = evaluatePolicy(makeCandidate(), cfg, {
      spec: { x: 1 },
      complexityOf: () => Number.NaN,
    });
    expect(verdict.decision).toBe("allow");
  });

  test("complexity is measured in UTF-8 bytes, not UTF-16 code units", () => {
    // 4-byte emoji (UTF-8) but 2 UTF-16 code units. Repeated 5 times in
    // canonical JSON form is `{"e":"💥💥💥💥💥"}` = ~28 UTF-8 bytes vs ~18
    // UTF-16 units. A 20-byte ceiling must deny when measuring bytes.
    const cfg = makeConfig({ maxComplexity: 20 });
    const { verdict } = evaluatePolicy(makeCandidate(), cfg, {
      spec: { e: "💥💥💥💥💥" },
    });
    expect(verdict.decision).toBe("deny");
  });
});
