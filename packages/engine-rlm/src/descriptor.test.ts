import { describe, expect, test } from "bun:test";
import type { AgentManifest } from "@koi/core";
import type { ResolutionContext } from "@koi/resolve";
import { descriptor } from "./descriptor.js";

/** Minimal context — factory throws before using it. */
const STUB_CONTEXT: ResolutionContext = {
  manifestDir: "/tmp",
  manifest: { name: "test" } as AgentManifest,
  env: {},
};

describe("descriptor", () => {
  test("has correct metadata", () => {
    expect(descriptor.kind).toBe("engine");
    expect(descriptor.name).toBe("@koi/engine-rlm");
    expect(descriptor.aliases).toContain("rlm");
  });

  test("has companion skills", () => {
    expect(descriptor.companionSkills).toBeDefined();
    expect(descriptor.companionSkills?.length).toBeGreaterThan(0);
  });

  test("factory throws with helpful message", () => {
    expect(() => descriptor.factory({}, STUB_CONTEXT)).toThrow(/modelCall handler/);
  });

  test("optionsValidator accepts valid object", () => {
    const result = descriptor.optionsValidator({});
    expect(result.ok).toBe(true);
  });

  test("optionsValidator accepts null/undefined", () => {
    const result1 = descriptor.optionsValidator(null);
    expect(result1.ok).toBe(true);
    const result2 = descriptor.optionsValidator(undefined);
    expect(result2.ok).toBe(true);
  });

  test("optionsValidator rejects non-object", () => {
    const result = descriptor.optionsValidator("invalid");
    expect(result.ok).toBe(false);
  });
});
