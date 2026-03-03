/**
 * Test fixture profiles — pre-built SandboxProfile instances for testing.
 *
 * Shared across all cloud sandbox adapter test suites.
 */

import type { SandboxProfile, TrustTier } from "@koi/core";

/** Create a minimal test profile for the given tier. */
export function createTestProfile(tier: TrustTier): SandboxProfile {
  switch (tier) {
    case "sandbox":
      return {
        tier: "sandbox",
        filesystem: {
          allowRead: ["/tmp"],
          allowWrite: ["/tmp"],
        },
        network: { allow: false },
        resources: {
          maxMemoryMb: 256,
          timeoutMs: 10_000,
          maxPids: 32,
          maxOpenFiles: 64,
        },
      };
    case "verified":
      return {
        tier: "verified",
        filesystem: {
          allowRead: ["/tmp", "/usr"],
          allowWrite: ["/tmp"],
        },
        network: { allow: true, allowedHosts: ["api.example.com"] },
        resources: {
          maxMemoryMb: 512,
          timeoutMs: 30_000,
          maxPids: 64,
          maxOpenFiles: 256,
        },
      };
    case "promoted":
      return {
        tier: "promoted",
        filesystem: {
          allowRead: ["/"],
          allowWrite: ["/tmp", "/home"],
        },
        network: { allow: true },
        resources: {
          maxMemoryMb: 2048,
          timeoutMs: 120_000,
          maxPids: 256,
          maxOpenFiles: 1024,
        },
      };
  }
}
