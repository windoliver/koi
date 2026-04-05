import { describe, expect, test } from "bun:test";

import type { SandboxProfile } from "@koi/core";

import { createOsAdapterForTest } from "./adapter.js";

const openProfile = (allow: boolean): SandboxProfile => ({
  filesystem: { defaultReadAccess: "open" },
  network: { allow },
  resources: {},
});

const closedProfile = (allow: boolean): SandboxProfile => ({
  filesystem: { defaultReadAccess: "closed" },
  network: { allow },
  resources: {},
});

describe("createOsAdapterForTest", () => {
  test("allows open defaultReadAccess on seatbelt", async () => {
    const adapter = createOsAdapterForTest({ platform: "seatbelt", available: true });
    // Should resolve without throwing
    const instance = await adapter.create(openProfile(true));
    expect(instance).toBeDefined();
  });

  test("rejects closed defaultReadAccess on seatbelt with VALIDATION error", async () => {
    const adapter = createOsAdapterForTest({ platform: "seatbelt", available: true });
    let caughtError: unknown;
    try {
      await adapter.create(closedProfile(true));
    } catch (e: unknown) {
      caughtError = e;
    }
    expect(caughtError).toBeInstanceOf(Error);
    // The cause is the KoiError with code VALIDATION
    const cause = (caughtError as Error & { cause?: { code?: string } }).cause;
    expect(cause?.code).toBe("VALIDATION");
  });

  test("allows closed defaultReadAccess on bwrap", async () => {
    const adapter = createOsAdapterForTest({ platform: "bwrap", available: true });
    const instance = await adapter.create(closedProfile(false));
    expect(instance).toBeDefined();
  });

  test("allows open defaultReadAccess on bwrap", async () => {
    const adapter = createOsAdapterForTest({ platform: "bwrap", available: true });
    const instance = await adapter.create(openProfile(true));
    expect(instance).toBeDefined();
  });
});
