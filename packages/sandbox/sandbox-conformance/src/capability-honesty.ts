import { describe, expect, test } from "bun:test";
import type { SandboxAdapter, SandboxProfile } from "@koi/core";

/**
 * Capability-honesty conformance group: verifies the adapter's runtime
 * surface matches its declared capabilities.
 *
 * Currently checks:
 *   - `persistence` declared ⇒ `findOrCreate` exists on the adapter
 *   - `spawn` declared ⇒ `instance.spawn` exists on a freshly-created instance
 */
export function describeCapabilityHonestyConformance(
  factory: () => SandboxAdapter,
  profile: () => SandboxProfile,
): void {
  describe("capability honesty", () => {
    test("persistence ⇒ findOrCreate is implemented", () => {
      const adapter = factory();
      const supports = adapter.capabilities?.supports;
      if (supports?.has("persistence")) {
        expect(typeof adapter.findOrCreate).toBe("function");
      } else {
        expect(true).toBe(true);
      }
    });

    test("spawn ⇒ instance.spawn is implemented", async () => {
      const adapter = factory();
      const supports = adapter.capabilities?.supports;
      if (!supports?.has("spawn")) {
        expect(true).toBe(true);
        return;
      }
      const instance = await adapter.create(profile());
      try {
        expect(typeof instance.spawn).toBe("function");
      } finally {
        await instance.destroy();
      }
    });
  });
}
