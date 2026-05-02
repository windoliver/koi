// packages/sandbox/sandbox-conformance/src/create-destroy.ts

import { describe, expect, test } from "bun:test";
import type { SandboxAdapter, SandboxProfile } from "@koi/core";

/**
 * Create+Destroy conformance group: verifies `create()` returns a usable
 * `SandboxInstance`, `destroy()` does not throw, and double-destroy is
 * idempotent.
 */
export function describeCreateDestroyConformance(
  factory: () => SandboxAdapter,
  profile: () => SandboxProfile,
): void {
  describe("create + destroy", () => {
    test("create() returns an instance with the documented surface", async () => {
      const adapter = factory();
      const instance = await adapter.create(profile());
      expect(typeof instance.exec).toBe("function");
      expect(typeof instance.readFile).toBe("function");
      expect(typeof instance.writeFile).toBe("function");
      expect(typeof instance.destroy).toBe("function");
      await instance.destroy();
    });

    test("destroy() is idempotent — calling twice does not throw", async () => {
      const adapter = factory();
      const instance = await adapter.create(profile());
      await instance.destroy();
      await instance.destroy();
      expect(true).toBe(true);
    });
  });
}
