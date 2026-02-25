import { describe, expect, test } from "bun:test";
import { EXTENSION_PRIORITY } from "./kernel-extension.js";

describe("EXTENSION_PRIORITY", () => {
  test("has correct values", () => {
    expect(EXTENSION_PRIORITY.CORE).toBe(0);
    expect(EXTENSION_PRIORITY.PLATFORM).toBe(10);
    expect(EXTENSION_PRIORITY.USER).toBe(50);
    expect(EXTENSION_PRIORITY.ADDON).toBe(100);
  });

  test("is frozen", () => {
    expect(Object.isFrozen(EXTENSION_PRIORITY)).toBe(true);
  });
});
