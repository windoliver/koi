import { describe, expect, test } from "bun:test";
import type { SandboxProfile } from "@koi/core";
import {
  detectUnsupportedProfileFields,
  extractProfileDefaults,
  formatUnsupportedProfileError,
} from "./profile.js";

describe("profile helpers", () => {
  test("preserves the legacy helper contract while sharing hosted-profile detection", () => {
    const profile: SandboxProfile = {
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
      nexusMounts: [
        {
          nexusUrl: "https://nexus.example.com",
          apiKey: "test-key",
          mountPath: "/mnt/nexus",
        },
      ],
    };

    const unsupported = detectUnsupportedProfileFields(profile);
    expect(unsupported).toEqual({
      fields: [
        "network.allow=false",
        "filesystem.defaultReadAccess=closed",
        "filesystem.allowRead",
        "filesystem.denyRead",
        "filesystem.allowWrite",
        "filesystem.denyWrite",
        "nexusMounts",
        "resources.maxMemoryMb",
        "resources.maxPids",
        "resources.maxOpenFiles",
      ],
    });

    if (unsupported === undefined) {
      throw new Error("expected legacy helper to report unsupported fields");
    }

    expect(formatUnsupportedProfileError(unsupported)).toBe(
      "sandbox-e2b cannot enforce profile fields: " +
        "network.allow=false, filesystem.defaultReadAccess=closed, filesystem.allowRead, " +
        "filesystem.denyRead, filesystem.allowWrite, filesystem.denyWrite, nexusMounts, " +
        "resources.maxMemoryMb, resources.maxPids, resources.maxOpenFiles. " +
        "The hosted backend has no provider-side hook for these yet (tracked in #1379). " +
        "Refuse to provision rather than silently weakening isolation.",
    );
  });

  test("extracts only supported profile defaults for exec forwarding", () => {
    const defaults = extractProfileDefaults({
      filesystem: { defaultReadAccess: "open" },
      network: { allow: true },
      resources: { timeoutMs: 1234, maxMemoryMb: 512 },
      env: { FROM_PROFILE: "1" },
    });

    expect(defaults).toEqual({
      env: { FROM_PROFILE: "1" },
      timeoutMs: 1234,
    });
  });
});
