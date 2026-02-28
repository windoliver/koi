import { describe, expect, test } from "bun:test";
import { descriptor } from "./descriptor.js";

describe("descriptor", () => {
  test("has correct kind and name", () => {
    expect(descriptor.kind).toBe("middleware");
    expect(descriptor.name).toBe("@koi/middleware-ace");
  });

  test("has aliases", () => {
    expect(descriptor.aliases).toEqual(["ace"]);
  });

  // ── optionsValidator ──

  test("rejects null options", () => {
    const result = descriptor.optionsValidator(null);
    expect(result.ok).toBe(false);
  });

  test("rejects undefined options", () => {
    const result = descriptor.optionsValidator(undefined);
    expect(result.ok).toBe(false);
  });

  test("rejects non-object options", () => {
    const result = descriptor.optionsValidator("string");
    expect(result.ok).toBe(false);
  });

  test("accepts empty object", () => {
    const result = descriptor.optionsValidator({});
    expect(result.ok).toBe(true);
  });

  test("accepts valid maxInjectionTokens", () => {
    const result = descriptor.optionsValidator({ maxInjectionTokens: 500 });
    expect(result.ok).toBe(true);
  });

  test("rejects non-positive maxInjectionTokens", () => {
    const result = descriptor.optionsValidator({ maxInjectionTokens: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });

  test("rejects negative maxInjectionTokens", () => {
    const result = descriptor.optionsValidator({ maxInjectionTokens: -1 });
    expect(result.ok).toBe(false);
  });

  test("rejects NaN maxInjectionTokens", () => {
    const result = descriptor.optionsValidator({ maxInjectionTokens: NaN });
    expect(result.ok).toBe(false);
  });

  test("rejects non-number maxInjectionTokens", () => {
    const result = descriptor.optionsValidator({ maxInjectionTokens: "500" });
    expect(result.ok).toBe(false);
  });

  test("accepts options with extra unknown properties", () => {
    const result = descriptor.optionsValidator({ unknownField: "hello" });
    expect(result.ok).toBe(true);
  });

  // ── factory ──

  test("factory creates middleware with default stores", () => {
    const middleware = descriptor.factory({});
    expect(middleware.name).toBe("ace");
    expect(typeof middleware.wrapModelCall).toBe("function");
    expect(typeof middleware.wrapToolCall).toBe("function");
    expect(typeof middleware.onSessionEnd).toBe("function");
  });

  test("factory creates middleware with maxInjectionTokens", () => {
    const middleware = descriptor.factory({ maxInjectionTokens: 200 });
    expect(middleware.name).toBe("ace");
  });

  test("factory middleware has describeCapabilities", () => {
    const middleware = descriptor.factory({});
    expect(typeof middleware.describeCapabilities).toBe("function");
  });
});
