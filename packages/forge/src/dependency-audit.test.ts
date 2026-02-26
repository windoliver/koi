/**
 * Tests for dependency audit gate — adversarial and happy-path coverage.
 */

import { describe, expect, test } from "bun:test";
import type { DependencyConfig } from "./config.js";
import { auditDependencies, auditTransitiveDependencies } from "./dependency-audit.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: DependencyConfig = {
  maxDependencies: 20,
  installTimeoutMs: 15_000,
  maxCacheSizeBytes: 1_073_741_824,
  maxWorkspaceAgeDays: 30,
  maxTransitiveDependencies: 200,
  maxBrickMemoryMb: 256,
  maxBrickPids: 32,
};

function configWith(overrides: Partial<DependencyConfig>): DependencyConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("auditDependencies (happy path)", () => {
  test("passes with valid packages", () => {
    const result = auditDependencies({ zod: "3.22.0", lodash: "4.17.21" }, DEFAULT_CONFIG);
    expect(result.ok).toBe(true);
  });

  test("passes with scoped packages", () => {
    const result = auditDependencies(
      { "@types/node": "20.0.0", "@koi/core": "1.0.0" },
      DEFAULT_CONFIG,
    );
    expect(result.ok).toBe(true);
  });

  test("passes with empty packages", () => {
    const result = auditDependencies({}, DEFAULT_CONFIG);
    expect(result.ok).toBe(true);
  });

  test("passes with pre-release semver", () => {
    const result = auditDependencies({ zod: "4.0.0-beta.1" }, DEFAULT_CONFIG);
    expect(result.ok).toBe(true);
  });

  test("passes with build metadata semver", () => {
    const result = auditDependencies({ zod: "3.22.0+build.123" }, DEFAULT_CONFIG);
    expect(result.ok).toBe(true);
  });

  test("passes when package is on allowlist", () => {
    const config = configWith({ allowedPackages: ["zod", "lodash"] });
    const result = auditDependencies({ zod: "3.22.0" }, config);
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Max dependency count
// ---------------------------------------------------------------------------

describe("auditDependencies (max count)", () => {
  test("rejects when exceeding maxDependencies", () => {
    const config = configWith({ maxDependencies: 2 });
    const result = auditDependencies({ a: "1.0.0", b: "1.0.0", c: "1.0.0" }, config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Too many dependencies");
      expect(result.error.message).toContain("3");
      expect(result.error.message).toContain("2");
    }
  });

  test("passes at exact limit", () => {
    const config = configWith({ maxDependencies: 2 });
    const result = auditDependencies({ a: "1.0.0", b: "1.0.0" }, config);
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Package name validation
// ---------------------------------------------------------------------------

describe("auditDependencies (name validation)", () => {
  test("rejects uppercase package name", () => {
    const result = auditDependencies({ MyPackage: "1.0.0" }, DEFAULT_CONFIG);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Invalid package name");
    }
  });

  test("rejects package name starting with dot", () => {
    const result = auditDependencies({ ".hidden": "1.0.0" }, DEFAULT_CONFIG);
    expect(result.ok).toBe(false);
  });

  test("rejects empty package name", () => {
    const result = auditDependencies({ "": "1.0.0" }, DEFAULT_CONFIG);
    expect(result.ok).toBe(false);
  });

  test("rejects package name with spaces", () => {
    const result = auditDependencies({ "my package": "1.0.0" }, DEFAULT_CONFIG);
    expect(result.ok).toBe(false);
  });

  test("rejects package name exceeding 214 characters", () => {
    const longName = "a".repeat(215);
    const result = auditDependencies({ [longName]: "1.0.0" }, DEFAULT_CONFIG);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("214");
    }
  });

  test("accepts package name at exactly 214 characters", () => {
    const maxName = "a".repeat(214);
    const result = auditDependencies({ [maxName]: "1.0.0" }, DEFAULT_CONFIG);
    expect(result.ok).toBe(true);
  });

  test("rejects path traversal in package name", () => {
    const result = auditDependencies({ "../etc/passwd": "1.0.0" }, DEFAULT_CONFIG);
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Semver validation
// ---------------------------------------------------------------------------

describe("auditDependencies (semver validation)", () => {
  test("rejects caret range", () => {
    const result = auditDependencies({ zod: "^3.22.0" }, DEFAULT_CONFIG);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("exact semver");
    }
  });

  test("rejects tilde range", () => {
    const result = auditDependencies({ zod: "~3.22.0" }, DEFAULT_CONFIG);
    expect(result.ok).toBe(false);
  });

  test("rejects >= range", () => {
    const result = auditDependencies({ zod: ">=3.22.0" }, DEFAULT_CONFIG);
    expect(result.ok).toBe(false);
  });

  test("rejects wildcard", () => {
    const result = auditDependencies({ zod: "*" }, DEFAULT_CONFIG);
    expect(result.ok).toBe(false);
  });

  test("rejects tag name", () => {
    const result = auditDependencies({ zod: "latest" }, DEFAULT_CONFIG);
    expect(result.ok).toBe(false);
  });

  test("rejects URL", () => {
    const result = auditDependencies({ zod: "https://github.com/colinhacks/zod" }, DEFAULT_CONFIG);
    expect(result.ok).toBe(false);
  });

  test("rejects git ref", () => {
    const result = auditDependencies(
      { zod: "git+https://github.com/colinhacks/zod.git" },
      DEFAULT_CONFIG,
    );
    expect(result.ok).toBe(false);
  });

  test("rejects OR range", () => {
    const result = auditDependencies({ zod: "3.22.0 || 3.23.0" }, DEFAULT_CONFIG);
    expect(result.ok).toBe(false);
  });

  test("rejects incomplete semver", () => {
    const result = auditDependencies({ zod: "3.22" }, DEFAULT_CONFIG);
    expect(result.ok).toBe(false);
  });

  test("rejects empty version", () => {
    const result = auditDependencies({ zod: "" }, DEFAULT_CONFIG);
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Allowlist / blocklist
// ---------------------------------------------------------------------------

describe("auditDependencies (allowlist/blocklist)", () => {
  test("rejects package not on allowlist", () => {
    const config = configWith({ allowedPackages: ["zod"] });
    const result = auditDependencies({ lodash: "4.17.21" }, config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("not in the allowed packages list");
    }
  });

  test("rejects blocked package", () => {
    const config = configWith({ blockedPackages: ["eval-pkg"] });
    const result = auditDependencies({ "eval-pkg": "1.0.0" }, config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("blocked");
    }
  });

  test("blocklist takes precedence over allowlist", () => {
    const config = configWith({
      allowedPackages: ["zod", "evil-pkg"],
      blockedPackages: ["evil-pkg"],
    });
    const result = auditDependencies({ "evil-pkg": "1.0.0" }, config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("blocked");
    }
  });

  test("empty allowlist means all allowed", () => {
    const config = configWith({ allowedPackages: [] });
    const result = auditDependencies({ "any-pkg": "1.0.0" }, config);
    expect(result.ok).toBe(true);
  });

  test("undefined allowlist means all allowed", () => {
    const result = auditDependencies({ "any-pkg": "1.0.0" }, DEFAULT_CONFIG);
    expect(result.ok).toBe(true);
  });

  test("empty blocklist means none blocked", () => {
    const config = configWith({ blockedPackages: [] });
    const result = auditDependencies({ "any-pkg": "1.0.0" }, config);
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Transitive dependency auditing
// ---------------------------------------------------------------------------

/** Minimal bun.lock JSONC with trailing commas (matches real format). */
function fakeLockfile(packages: Record<string, readonly unknown[]>): string {
  const entries = Object.entries(packages)
    .map(([name, value]) => `    "${name}": ${JSON.stringify(value)},`)
    .join("\n");
  return `{
  "lockfileVersion": 1,
  "workspaces": {},
  "packages": {
${entries}
  },
}`;
}

describe("auditTransitiveDependencies", () => {
  test("passes when no blocklist configured", () => {
    const lock = fakeLockfile({ "evil-pkg": ["evil-pkg@1.0.0"] });
    const result = auditTransitiveDependencies(lock, DEFAULT_CONFIG);
    expect(result.ok).toBe(true);
  });

  test("passes when no transitive deps are blocked", () => {
    const config = configWith({ blockedPackages: ["evil-pkg"] });
    const lock = fakeLockfile({
      lodash: ["lodash@4.17.21"],
      zod: ["zod@3.22.0"],
    });
    const result = auditTransitiveDependencies(lock, config);
    expect(result.ok).toBe(true);
  });

  test("rejects when transitive dep is on blocklist", () => {
    const config = configWith({ blockedPackages: ["evil-pkg"] });
    const lock = fakeLockfile({
      lodash: ["lodash@4.17.21"],
      "evil-pkg": ["evil-pkg@1.0.0"],
    });
    const result = auditTransitiveDependencies(lock, config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Transitive dependency");
      expect(result.error.message).toContain("evil-pkg");
      expect(result.error.message).toContain("blocked");
    }
  });

  test("passes gracefully on invalid JSONC", () => {
    const config = configWith({ blockedPackages: ["evil-pkg"] });
    const result = auditTransitiveDependencies("not json at all {{{", config);
    expect(result.ok).toBe(true);
  });

  test("passes gracefully when packages key is missing", () => {
    const config = configWith({ blockedPackages: ["evil-pkg"] });
    const result = auditTransitiveDependencies('{ "lockfileVersion": 1 }', config);
    expect(result.ok).toBe(true);
  });

  test("detects scoped transitive deps on blocklist", () => {
    const config = configWith({ blockedPackages: ["@evil/core"] });
    const lock = fakeLockfile({
      lodash: ["lodash@4.17.21"],
      "@evil/core": ["@evil/core@2.0.0"],
    });
    const result = auditTransitiveDependencies(lock, config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("@evil/core");
    }
  });

  test("empty blocklist passes all transitive deps", () => {
    const config = configWith({ blockedPackages: [] });
    const lock = fakeLockfile({ anything: ["anything@1.0.0"] });
    const result = auditTransitiveDependencies(lock, config);
    expect(result.ok).toBe(true);
  });

  test("rejects when transitive count exceeds maxTransitiveDependencies", () => {
    const config = configWith({ maxTransitiveDependencies: 3 });
    const lock = fakeLockfile({
      a: ["a@1.0.0"],
      b: ["b@1.0.0"],
      c: ["c@1.0.0"],
      d: ["d@1.0.0"],
    });
    const result = auditTransitiveDependencies(lock, config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Too many transitive dependencies");
      expect(result.error.message).toContain("4");
      expect(result.error.message).toContain("3");
    }
  });

  test("passes at exact transitive count limit", () => {
    const config = configWith({ maxTransitiveDependencies: 3 });
    const lock = fakeLockfile({
      a: ["a@1.0.0"],
      b: ["b@1.0.0"],
      c: ["c@1.0.0"],
    });
    const result = auditTransitiveDependencies(lock, config);
    expect(result.ok).toBe(true);
  });

  test("transitive count check runs even without blocklist", () => {
    const config = configWith({ maxTransitiveDependencies: 2 });
    const lock = fakeLockfile({
      a: ["a@1.0.0"],
      b: ["b@1.0.0"],
      c: ["c@1.0.0"],
    });
    const result = auditTransitiveDependencies(lock, config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Too many transitive dependencies");
    }
  });
});
