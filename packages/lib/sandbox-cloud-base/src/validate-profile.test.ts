import { describe, expect, test } from "bun:test";
import type { SandboxProfile } from "@koi/core";
import {
  detectUnsupportedProfileFields,
  formatUnsupportedProfileError,
} from "./validate-profile.js";

function createPermissiveProfile(): SandboxProfile {
  return {
    filesystem: {
      defaultReadAccess: "open",
    },
    network: {
      allow: true,
    },
    resources: {},
  };
}

describe("validate-profile", () => {
  test("returns undefined for permissive profiles", () => {
    expect(detectUnsupportedProfileFields(createPermissiveProfile())).toBeUndefined();
  });

  test("detects closed filesystem, network deny, and resource caps", () => {
    const unsupported = detectUnsupportedProfileFields({
      filesystem: {
        defaultReadAccess: "closed",
        allowRead: ["/allowed/read"],
        denyRead: ["/denied/read"],
        allowWrite: ["/allowed/write"],
        denyWrite: ["/denied/write"],
      },
      network: {
        allow: false,
      },
      resources: {
        maxMemoryMb: 512,
        maxPids: 16,
        maxOpenFiles: 64,
      },
    });

    expect(unsupported).toEqual({
      filesystem: true,
      network: true,
      resources: true,
      details: [
        "filesystem restrictions or Nexus mounts",
        "network deny (allow=false)",
        "resource limits (maxMemoryMb/maxPids/maxOpenFiles)",
      ],
    });
  });

  test("adapter-specific fail-closed guidance includes the adapter name and detail", () => {
    const message = formatUnsupportedProfileError("sandbox-e2b", {
      filesystem: false,
      network: true,
      resources: true,
      details: [
        "network deny (allow=false)",
        "resource limits (maxMemoryMb/maxPids/maxOpenFiles)",
      ],
    });

    expect(message).toBe(
      "sandbox-e2b cannot enforce the following SandboxProfile policies: " +
        "network deny (allow=false), resource limits (maxMemoryMb/maxPids/maxOpenFiles). " +
        "Use @koi/sandbox-docker or @koi/sandbox-os for policy enforcement, or relax the profile to proceed.",
    );
  });
});
