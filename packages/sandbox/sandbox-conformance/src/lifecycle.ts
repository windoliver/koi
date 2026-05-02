// packages/sandbox/sandbox-conformance/src/lifecycle.ts
import { describe, expect, test } from "bun:test";
import type { SandboxAdapter } from "@koi/core";

/**
 * Lifecycle conformance group: verifies optional `init` and `shutdown` hooks
 * are idempotent and that a fresh adapter built by `factory()` reaches usable
 * state without throwing.
 *
 * `factory` MUST return a fresh, never-init'd adapter on each call. The suite
 * builds and tears down its own adapter; the caller's surrounding test
 * harness should not.
 */
export function describeLifecycleConformance(factory: () => SandboxAdapter): void {
  describe("lifecycle", () => {
    test("init() resolves without error (or is omitted)", async () => {
      const adapter = factory();
      if (adapter.init !== undefined) {
        await adapter.init();
      }
      expect(true).toBe(true);
    });

    test("shutdown() is idempotent (calling twice does not throw)", async () => {
      const adapter = factory();
      if (adapter.init !== undefined) {
        await adapter.init();
      }
      if (adapter.shutdown !== undefined) {
        await adapter.shutdown();
        await adapter.shutdown();
      }
      expect(true).toBe(true);
    });

    test("init() can be called twice without throwing (idempotent)", async () => {
      const adapter = factory();
      if (adapter.init !== undefined) {
        await adapter.init();
        await adapter.init();
      }
      expect(true).toBe(true);
    });
  });
}
