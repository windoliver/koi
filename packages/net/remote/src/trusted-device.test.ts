import { describe, expect, test } from "bun:test";

import { createInMemoryTrustedDeviceRegistry } from "./index.js";

describe("createInMemoryTrustedDeviceRegistry", () => {
  test("newly registered subject and device id is trusted", () => {
    const registry = createInMemoryTrustedDeviceRegistry();

    registry.register({
      subject: "user-1",
      deviceId: "device-1",
      registeredAt: 1_000,
      metadata: { label: "laptop" },
    });

    expect(registry.isTrusted("user-1", "device-1")).toBe(true);
    expect(registry.lookup("user-1", "device-1")).toEqual({
      subject: "user-1",
      deviceId: "device-1",
      registeredAt: 1_000,
      metadata: { label: "laptop" },
    });
  });

  test("revoked device is not trusted", () => {
    const registry = createInMemoryTrustedDeviceRegistry();

    registry.register({
      subject: "user-1",
      deviceId: "device-1",
      registeredAt: 1_000,
      metadata: {},
    });
    registry.revoke("user-1", "device-1", 2_000);

    expect(registry.isTrusted("user-1", "device-1")).toBe(false);
    expect(registry.lookup("user-1", "device-1")).toEqual({
      subject: "user-1",
      deviceId: "device-1",
      registeredAt: 1_000,
      revokedAt: 2_000,
      metadata: {},
    });
  });

  test("revoking an unregistered device creates a revoked record", () => {
    const registry = createInMemoryTrustedDeviceRegistry();

    registry.revoke("user-1", "device-1", 2_000);

    expect(registry.isTrusted("user-1", "device-1")).toBe(false);
    expect(registry.lookup("user-1", "device-1")).toEqual({
      subject: "user-1",
      deviceId: "device-1",
      registeredAt: 2_000,
      revokedAt: 2_000,
      metadata: {},
    });
  });

  test("revocation wins if called repeatedly and registered again", () => {
    const registry = createInMemoryTrustedDeviceRegistry();

    registry.register({
      subject: "user-1",
      deviceId: "device-1",
      registeredAt: 1_000,
      metadata: { label: "first" },
    });
    registry.revoke("user-1", "device-1", 2_000);
    registry.revoke("user-1", "device-1", 3_000);
    registry.register({
      subject: "user-1",
      deviceId: "device-1",
      registeredAt: 4_000,
      metadata: { label: "second" },
    });

    expect(registry.isTrusted("user-1", "device-1")).toBe(false);
    expect(registry.lookup("user-1", "device-1")).toEqual({
      subject: "user-1",
      deviceId: "device-1",
      registeredAt: 1_000,
      revokedAt: 3_000,
      metadata: { label: "first" },
    });
  });

  test("another subject cannot reuse the same device id", () => {
    const registry = createInMemoryTrustedDeviceRegistry();

    registry.register({
      subject: "user-1",
      deviceId: "device-1",
      registeredAt: 1_000,
      metadata: {},
    });

    expect(registry.isTrusted("user-2", "device-1")).toBe(false);
    expect(registry.lookup("user-2", "device-1")).toBeUndefined();
  });

  test("subject and device id delimiters cannot collide", () => {
    const registry = createInMemoryTrustedDeviceRegistry();

    registry.register({
      subject: "user\0device",
      deviceId: "x",
      registeredAt: 1_000,
      metadata: {},
    });

    expect(registry.isTrusted("user", "device\0x")).toBe(false);
    expect(registry.lookup("user", "device\0x")).toBeUndefined();
  });

  test("lookup results cannot be mutated to bypass registry state", () => {
    const registry = createInMemoryTrustedDeviceRegistry();

    const metadata: Record<string, unknown> = {
      label: "laptop",
      nested: { zone: "home" },
    };
    registry.register({
      subject: "user-1",
      deviceId: "device-1",
      registeredAt: 1_000,
      metadata,
    });
    metadata.label = "changed by caller";
    (metadata.nested as { zone: string }).zone = "office";
    registry.revoke("user-1", "device-1", 2_000);

    const lookup = registry.lookup("user-1", "device-1");
    expect(lookup).toEqual({
      subject: "user-1",
      deviceId: "device-1",
      registeredAt: 1_000,
      revokedAt: 2_000,
      metadata: { label: "laptop", nested: { zone: "home" } },
    });

    if (lookup !== undefined) {
      delete (lookup as { revokedAt?: number }).revokedAt;
      (lookup.metadata as Record<string, unknown>).label = "mutated by lookup";
      ((lookup.metadata as Record<string, unknown>).nested as { zone: string }).zone =
        "mutated nested";
    }

    expect(registry.isTrusted("user-1", "device-1")).toBe(false);
    expect(registry.lookup("user-1", "device-1")).toEqual({
      subject: "user-1",
      deviceId: "device-1",
      registeredAt: 1_000,
      revokedAt: 2_000,
      metadata: { label: "laptop", nested: { zone: "home" } },
    });
  });
});
