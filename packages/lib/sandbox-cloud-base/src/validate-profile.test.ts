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
      fields: [
        "network.allow=false",
        "filesystem.defaultReadAccess=closed",
        "filesystem.allowRead",
        "filesystem.denyRead",
        "filesystem.allowWrite",
        "filesystem.denyWrite",
        "resources.maxMemoryMb",
        "resources.maxPids",
        "resources.maxOpenFiles",
      ],
    });
  });

  test("adapter-specific fail-closed guidance includes the adapter name and detail", () => {
    const message = formatUnsupportedProfileError("sandbox-e2b", {
      fields: ["network.allow=false", "resources.maxMemoryMb"],
    });

    expect(message).toContain("sandbox-e2b");
    expect(message).toContain("network.allow=false");
    expect(message).toContain("resources.maxMemoryMb");
    expect(message).toContain("@koi/sandbox-docker");
    expect(message).toContain("@koi/sandbox-os");
  });
});
