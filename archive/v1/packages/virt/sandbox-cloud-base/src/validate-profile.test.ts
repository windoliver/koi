/**
 * Tests for SandboxProfile validation — cloud adapter policy detection.
 */

import { describe, expect, test } from "bun:test";
import type { SandboxProfile } from "@koi/core";
import {
  detectUnsupportedProfileFields,
  formatUnsupportedProfileError,
} from "./validate-profile.js";

function permissiveProfile(): SandboxProfile {
  return {
    filesystem: { allowRead: ["/"], allowWrite: ["/"] },
    network: { allow: true },
    resources: {},
  };
}

describe("detectUnsupportedProfileFields", () => {
  test("returns undefined for a fully permissive profile", () => {
    const result = detectUnsupportedProfileFields(permissiveProfile());
    expect(result).toBeUndefined();
  });

  test("returns undefined when filesystem has no restrictions", () => {
    const profile: SandboxProfile = {
      filesystem: {},
      network: { allow: true },
      resources: {},
    };
    expect(detectUnsupportedProfileFields(profile)).toBeUndefined();
  });

  test("detects filesystem deny rules", () => {
    const profile: SandboxProfile = {
      filesystem: { denyRead: ["/etc/secrets"] },
      network: { allow: true },
      resources: {},
    };
    const result = detectUnsupportedProfileFields(profile);
    expect(result).toBeDefined();
    expect(result?.filesystem).toBe(true);
    expect(result?.network).toBe(false);
  });

  test("detects restrictive allowRead (non-root)", () => {
    const profile: SandboxProfile = {
      filesystem: { allowRead: ["/tmp", "/usr"] },
      network: { allow: true },
      resources: {},
    };
    const result = detectUnsupportedProfileFields(profile);
    expect(result).toBeDefined();
    expect(result?.filesystem).toBe(true);
  });

  test("detects network deny", () => {
    const profile: SandboxProfile = {
      filesystem: {},
      network: { allow: false },
      resources: {},
    };
    const result = detectUnsupportedProfileFields(profile);
    expect(result).toBeDefined();
    expect(result?.network).toBe(true);
    expect(result?.details).toContain("network deny (allow=false)");
  });

  test("detects network allowedHosts restriction", () => {
    const profile: SandboxProfile = {
      filesystem: {},
      network: { allow: true, allowedHosts: ["api.example.com"] },
      resources: {},
    };
    const result = detectUnsupportedProfileFields(profile);
    expect(result).toBeDefined();
    expect(result?.network).toBe(true);
    expect(result?.details).toContain("network host restrictions (allowedHosts)");
  });

  test("detects resource limits", () => {
    const profile: SandboxProfile = {
      filesystem: {},
      network: { allow: true },
      resources: { maxMemoryMb: 256 },
    };
    const result = detectUnsupportedProfileFields(profile);
    expect(result).toBeDefined();
    expect(result?.resources).toBe(true);
  });

  test("accepts environment variables (forwarded per-command)", () => {
    const profile: SandboxProfile = {
      filesystem: {},
      network: { allow: true },
      resources: {},
      env: { NODE_ENV: "production" },
    };
    const result = detectUnsupportedProfileFields(profile);
    expect(result).toBeUndefined();
  });

  test("detects multiple unsupported fields", () => {
    const profile: SandboxProfile = {
      filesystem: { denyRead: ["/secrets"] },
      network: { allow: false },
      resources: { maxPids: 32 },
      env: { FOO: "bar" },
    };
    const result = detectUnsupportedProfileFields(profile);
    expect(result).toBeDefined();
    expect(result?.filesystem).toBe(true);
    expect(result?.network).toBe(true);
    expect(result?.resources).toBe(true);
    expect(result?.env).toBe(false);
    expect(result?.details.length).toBe(3);
  });
});

describe("formatUnsupportedProfileError", () => {
  test("includes adapter name and all unsupported fields", () => {
    const unsupported = detectUnsupportedProfileFields({
      filesystem: { denyRead: ["/secrets"] },
      network: { allow: false },
      resources: {},
    });
    expect(unsupported).toBeDefined();
    if (unsupported === undefined) return;

    const msg = formatUnsupportedProfileError("E2B", unsupported);
    expect(msg).toContain("E2B");
    expect(msg).toContain("filesystem");
    expect(msg).toContain("network");
    expect(msg).toContain("Docker or OS adapter");
  });
});
