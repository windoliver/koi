/**
 * Unit tests for the metadata accessor helper.
 */

import { describe, expect, test } from "bun:test";
import { getMetadataKey } from "./metadata.js";

describe("getMetadataKey", () => {
  test("returns undefined when metadata is undefined", () => {
    expect(getMetadataKey(undefined, "anything")).toBeUndefined();
  });

  test("returns undefined when key is absent", () => {
    expect(getMetadataKey({ other: "value" }, "missing")).toBeUndefined();
  });

  test("returns a string value", () => {
    expect(getMetadataKey({ preset: "strict" }, "preset")).toBe("strict");
  });

  test("returns a number value", () => {
    expect(getMetadataKey({ maxCostUsd: 10 }, "maxCostUsd")).toBe(10);
  });

  test("returns a nested object by reference", () => {
    const nested = { verification: true };
    const result = getMetadataKey({ forge: nested }, "forge");
    expect(result).toBe(nested);
  });

  test("returns null when key maps to null", () => {
    expect(getMetadataKey({ key: null }, "key")).toBeNull();
  });

  test("returns false boolean", () => {
    expect(getMetadataKey({ enabled: false }, "enabled")).toBe(false);
  });

  test("returns empty object", () => {
    const empty = {};
    expect(getMetadataKey({ forge: empty }, "forge")).toBe(empty);
  });
});
