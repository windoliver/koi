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
