/**
 * Test fixture profiles — pre-built SandboxProfile instances for testing.
 *
 * Shared across all cloud sandbox adapter test suites.
 */

import type { SandboxProfile, ToolPolicy } from "@koi/core";

/** Create a minimal test profile for the given policy. */
export function createTestProfile(policy: ToolPolicy): SandboxProfile {
  if (policy.sandbox) {
    return {
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
  }
  return {
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
