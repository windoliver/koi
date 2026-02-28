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

describe("filesystem descriptor", () => {
  test("has correct kind and name", () => {
    expect(descriptor.kind).toBe("tool");
    expect(descriptor.name).toBe("@koi/filesystem");
  });

  test("has aliases", () => {
    expect(descriptor.aliases).toEqual(["filesystem", "fs"]);
  });

  test("validates empty options as valid", () => {
    const result = descriptor.optionsValidator({});
    expect(result.ok).toBe(true);
  });

  test("validates null/undefined options as valid", () => {
    expect(descriptor.optionsValidator(null).ok).toBe(true);
    expect(descriptor.optionsValidator(undefined).ok).toBe(true);
  });

  test("rejects non-object options", () => {
    const stringResult = descriptor.optionsValidator("bad");
    expect(stringResult.ok).toBe(false);
    if (!stringResult.ok) {
      expect(stringResult.error.code).toBe("VALIDATION");
    }

    const numberResult = descriptor.optionsValidator(42);
    expect(numberResult.ok).toBe(false);
  });

  test("validates operations as array of valid ops", () => {
    const valid = descriptor.optionsValidator({ operations: ["read", "write"] });
    expect(valid.ok).toBe(true);

    const invalid = descriptor.optionsValidator({ operations: ["invalid"] });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.error.message).toContain("invalid");
    }

    const notArray = descriptor.optionsValidator({ operations: "not-array" });
    expect(notArray.ok).toBe(false);
    if (!notArray.ok) {
      expect(notArray.error.message).toContain("array");
    }
  });

  test("validates prefix as string", () => {
    const valid = descriptor.optionsValidator({ prefix: "s3" });
    expect(valid.ok).toBe(true);

    const invalid = descriptor.optionsValidator({ prefix: 123 });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.error.message).toContain("prefix");
    }
  });

  test("validates trustTier as enum", () => {
    for (const tier of ["sandbox", "verified", "promoted"]) {
      expect(descriptor.optionsValidator({ trustTier: tier }).ok).toBe(true);
    }

    const invalid = descriptor.optionsValidator({ trustTier: "invalid" });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.error.message).toContain("trustTier");
    }
  });

  test("accepts all valid options combined", () => {
    const result = descriptor.optionsValidator({
      operations: ["read", "write", "edit", "list", "search"],
      prefix: "s3",
      trustTier: "sandbox",
    });
    expect(result.ok).toBe(true);
  });

  test("factory throws with helpful message", () => {
    expect(() => descriptor.factory({}, STUB_CONTEXT)).toThrow("FileSystemBackend");
  });
});
