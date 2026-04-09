import { describe, expect, test } from "bun:test";

import type { SandboxProfile } from "@koi/core";

import { validateProfile } from "./validate.js";

const BASE_PROFILE: SandboxProfile = {
  filesystem: {
    defaultReadAccess: "open",
  },
  network: {
    allow: true,
  },
  resources: {},
};

function withFilesystem(filesystem: SandboxProfile["filesystem"]): SandboxProfile {
  return {
    ...BASE_PROFILE,
    filesystem,
  };
}

describe("validateProfile", () => {
  test("rejects relative allowRead paths", () => {
    const result = validateProfile(
      withFilesystem({
        defaultReadAccess: "open",
        allowRead: ["relative/path"],
      }),
      "bwrap",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });

  test("rejects explicit relative denyRead paths", () => {
    const result = validateProfile(
      withFilesystem({
        defaultReadAccess: "open",
        denyRead: ["./explicit-relative"],
      }),
      "bwrap",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });

  test("accepts absolute paths", () => {
    const result = validateProfile(
      withFilesystem({
        defaultReadAccess: "open",
        allowRead: ["/absolute/path"],
      }),
      "bwrap",
    );

    expect(result).toEqual({
      ok: true,
      value: withFilesystem({
        defaultReadAccess: "open",
        allowRead: ["/absolute/path"],
      }),
    });
  });

  test("accepts tilde-prefixed paths", () => {
    const result = validateProfile(
      withFilesystem({
        defaultReadAccess: "open",
        allowRead: ["~/home/path"],
      }),
      "bwrap",
    );

    expect(result.ok).toBe(true);
  });

  test("rejects closed defaultReadAccess on seatbelt", () => {
    const result = validateProfile(
      withFilesystem({
        defaultReadAccess: "closed",
      }),
      "seatbelt",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("dyld");
    }
  });

  test("accepts closed defaultReadAccess on bwrap", () => {
    const result = validateProfile(
      withFilesystem({
        defaultReadAccess: "closed",
      }),
      "bwrap",
    );

    expect(result.ok).toBe(true);
  });

  test("accepts open defaultReadAccess on seatbelt", () => {
    const result = validateProfile(
      withFilesystem({
        defaultReadAccess: "open",
      }),
      "seatbelt",
    );

    expect(result.ok).toBe(true);
  });

  test("accepts open defaultReadAccess on bwrap", () => {
    const result = validateProfile(
      withFilesystem({
        defaultReadAccess: "open",
      }),
      "bwrap",
    );

    expect(result.ok).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Issue 8: Glob pattern rejection in path fields
  // ---------------------------------------------------------------------------

  test("rejects glob patterns in allowWrite", () => {
    const result = validateProfile(
      withFilesystem({
        defaultReadAccess: "open",
        allowWrite: ["/home/user/project/*.ts"],
      }),
      "bwrap",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("glob");
    }
  });

  test("rejects glob patterns in allowRead", () => {
    const result = validateProfile(
      withFilesystem({
        defaultReadAccess: "open",
        allowRead: ["/home/user/src/*.ts"],
      }),
      "bwrap",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("glob");
    }
  });

  test("rejects glob patterns in denyRead", () => {
    const result = validateProfile(
      withFilesystem({
        defaultReadAccess: "open",
        denyRead: ["~/.ssh/*.pem"],
      }),
      "bwrap",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });

  test("rejects glob patterns in denyWrite", () => {
    const result = validateProfile(
      withFilesystem({
        defaultReadAccess: "open",
        allowWrite: ["/tmp"],
        denyWrite: ["/tmp/secrets*"],
      }),
      "bwrap",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });

  test("accepts non-glob paths that happen to contain similar characters", () => {
    // Make sure normal paths with brackets or dots don't trigger the glob check
    const result = validateProfile(
      withFilesystem({
        defaultReadAccess: "open",
        allowRead: ["/home/user/.config", "/var/log/app"],
      }),
      "bwrap",
    );

    expect(result.ok).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Issue 7: Closed mode + resource limits — /bin/sh presence check
  // ---------------------------------------------------------------------------

  test("rejects closed bwrap + resource limits when /bin/bash is NOT in allowRead", () => {
    const result = validateProfile(
      {
        filesystem: {
          defaultReadAccess: "closed",
          allowRead: ["/home/user"],
        },
        network: { allow: false },
        resources: { maxPids: 32 },
      },
      "bwrap",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("/bin/bash");
    }
  });

  test("accepts closed bwrap + resource limits when /bin/bash is explicitly in allowRead", () => {
    const result = validateProfile(
      {
        filesystem: {
          defaultReadAccess: "closed",
          allowRead: ["/bin/bash", "/home/user"],
        },
        network: { allow: false },
        resources: { maxPids: 32 },
      },
      "bwrap",
    );

    expect(result.ok).toBe(true);
  });

  test("accepts closed bwrap + resource limits when /bin directory is in allowRead", () => {
    const result = validateProfile(
      {
        filesystem: {
          defaultReadAccess: "closed",
          allowRead: ["/bin", "/usr", "/lib"],
        },
        network: { allow: false },
        resources: { maxOpenFiles: 256 },
      },
      "bwrap",
    );

    expect(result.ok).toBe(true);
  });

  test("accepts closed bwrap + resource limits when entire root / is in allowRead", () => {
    const result = validateProfile(
      {
        filesystem: {
          defaultReadAccess: "closed",
          allowRead: ["/"],
        },
        network: { allow: false },
        resources: { maxPids: 16, maxOpenFiles: 128 },
      },
      "bwrap",
    );

    expect(result.ok).toBe(true);
  });

  test("accepts closed bwrap with no resource limits (no sh wrapper needed)", () => {
    const result = validateProfile(
      {
        filesystem: {
          defaultReadAccess: "closed",
          allowRead: ["/home/user"],
        },
        network: { allow: false },
        resources: {},
      },
      "bwrap",
    );

    expect(result.ok).toBe(true);
  });
});
