import { describe, expect, test } from "bun:test";
import { platform } from "node:os";
import { createSecureStorage } from "./factory.js";

describe("createSecureStorage", () => {
  test("returns a storage implementation on supported platforms", () => {
    const os = platform();
    if (os === "darwin" || os === "linux") {
      const storage = createSecureStorage();
      expect(storage).toBeDefined();
      expect(typeof storage.get).toBe("function");
      expect(typeof storage.set).toBe("function");
      expect(typeof storage.delete).toBe("function");
      expect(typeof storage.withLock).toBe("function");
    }
  });

  test("factory returns correct type for current platform", () => {
    const os = platform();
    if (os !== "darwin" && os !== "linux") {
      expect(() => createSecureStorage()).toThrow(/No secure storage available/);
    }
  });
});
