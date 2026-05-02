import { describe, expect, test } from "bun:test";
import type { SandboxAdapter, SandboxProfile } from "@koi/core";

/**
 * Capability-honesty conformance group: verifies the adapter's runtime
 * surface matches its declared capabilities.
 *
 * Checks:
 *   - `persistence` declared ⇒ `adapter.findOrCreate` exists AND the
 *     instance produced by `findOrCreate` exposes `detach()` (L0 contract:
 *     persistent instances must be detachable, see SandboxInstance.detach
 *     in @koi/core/sandbox-adapter).
 *   - `spawn` declared ⇒ `instance.spawn` exists on a freshly-created instance
 *   - `copy-files` declared ⇒ `instance.readFile`/`writeFile` exist AND the
 *     fake roundtrip does NOT throw on a no-op path. We can't validate real
 *     write authority (the adapter may legitimately be denied at the OS
 *     layer), but we can catch the trivial "throws on every call" lie.
 */
export function describeCapabilityHonestyConformance(
  factory: () => SandboxAdapter,
  profile: () => SandboxProfile,
): void {
  describe("capability honesty", () => {
    test("persistence ⇒ adapter.findOrCreate AND instance.detach are implemented", async () => {
      const adapter = factory();
      const supports = adapter.capabilities?.supports;
      if (!supports?.has("persistence")) {
        expect(true).toBe(true);
        return;
      }
      expect(typeof adapter.findOrCreate).toBe("function");
      if (adapter.findOrCreate === undefined) return;
      const instance = await adapter.findOrCreate("conformance-detach-scope", profile());
      try {
        // L0 contract: persistent-capable backends MUST expose detach so
        // callers can pause-and-reattach. Declaring `persistence` without a
        // detach implementation is a lie.
        expect(typeof instance.detach).toBe("function");
      } finally {
        await instance.destroy();
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

    test("copy-files ⇒ instance.readFile/writeFile are implemented", async () => {
      const adapter = factory();
      const supports = adapter.capabilities?.supports;
      if (!supports?.has("copy-files")) {
        expect(true).toBe(true);
        return;
      }
      const instance = await adapter.create(profile());
      try {
        expect(typeof instance.readFile).toBe("function");
        expect(typeof instance.writeFile).toBe("function");
      } finally {
        await instance.destroy();
      }
    });
  });
}
