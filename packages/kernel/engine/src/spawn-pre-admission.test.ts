import { describe, expect, test } from "bun:test";
import type { KoiError } from "@koi/core";

import { markPreAdmission, stripPreAdmission } from "./spawn-pre-admission.js";

describe("markPreAdmission", () => {
  test("sets context.preAdmission = true", () => {
    const base: KoiError = { code: "NOT_FOUND", message: "x", retryable: false };
    const marked = markPreAdmission(base);
    expect((marked.context as { readonly preAdmission?: unknown })?.preAdmission).toBe(true);
  });

  test("preserves existing context fields", () => {
    const base: KoiError = {
      code: "VALIDATION",
      message: "x",
      retryable: false,
      context: { field: "name", prior: 42 },
    };
    const marked = markPreAdmission(base);
    const ctx = marked.context as Record<string, unknown>;
    expect(ctx.field).toBe("name");
    expect(ctx.prior).toBe(42);
    expect(ctx.preAdmission).toBe(true);
  });

  test("does not mutate the input", () => {
    const base: KoiError = { code: "INTERNAL", message: "x", retryable: false };
    markPreAdmission(base);
    expect(base.context).toBeUndefined();
  });
});

describe("stripPreAdmission (#1793 forged-marker defence)", () => {
  test("removes a forged preAdmission flag from a child error", () => {
    // A child agent could throw KoiRuntimeError{context:{preAdmission:true}}
    // to bypass the parent's per-turn fan-out cap. runSpawnedAgent's
    // post-admission catch must strip the marker before returning the
    // error to the parent.
    const forged: KoiError = {
      code: "INTERNAL",
      message: "child crashed",
      retryable: false,
      context: { preAdmission: true, childInfo: "keep" },
    };
    const stripped = stripPreAdmission(forged);
    const ctx = stripped.context as Record<string, unknown>;
    expect("preAdmission" in ctx).toBe(false);
    expect(ctx.childInfo).toBe("keep");
  });

  test("leaves errors without preAdmission untouched", () => {
    const error: KoiError = {
      code: "INTERNAL",
      message: "x",
      retryable: false,
      context: { other: "value" },
    };
    const stripped = stripPreAdmission(error);
    expect(stripped).toBe(error);
  });

  test("leaves errors without context untouched", () => {
    const error: KoiError = { code: "INTERNAL", message: "x", retryable: false };
    const stripped = stripPreAdmission(error);
    expect(stripped).toBe(error);
  });
});
