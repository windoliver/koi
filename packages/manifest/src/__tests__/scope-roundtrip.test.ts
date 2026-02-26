import { describe, expect, test } from "bun:test";
import { loadManifestFromString } from "../loader.js";
import type { ManifestScopeConfig } from "../types.js";

// ---------------------------------------------------------------------------
// manifest scope round-trip
// ---------------------------------------------------------------------------

describe("manifest scope round-trip", () => {
  test("loadManifestFromString with scope section populates LoadedManifest.scope", () => {
    const yaml = `
name: research-agent
version: "0.1.0"
model: anthropic:claude-sonnet-4-5-20250929

scope:
  filesystem:
    root: /workspace/src
    mode: ro
  browser:
    allowedDomains:
      - docs.example.com
    blockPrivateAddresses: true
    trustTier: verified
  credentials:
    keyPattern: "api_key_*"
  memory:
    namespace: research-agent
`;
    const result = loadManifestFromString(yaml);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const scope = result.value.manifest.scope as ManifestScopeConfig;
    expect(scope).toBeDefined();
    expect(scope.filesystem).toEqual({ root: "/workspace/src", mode: "ro" });
    expect(scope.browser).toEqual({
      allowedDomains: ["docs.example.com"],
      blockPrivateAddresses: true,
      trustTier: "verified",
    });
    expect(scope.credentials).toEqual({ keyPattern: "api_key_*" });
    expect(scope.memory).toEqual({ namespace: "research-agent" });
  });

  test("scope field in KNOWN_FIELDS produces no warning", () => {
    const yaml = `
name: test-agent
version: "0.1.0"
model: test-model

scope:
  filesystem:
    root: /tmp
`;
    const result = loadManifestFromString(yaml);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const scopeWarnings = result.value.warnings.filter((w) => w.path === "scope");
    expect(scopeWarnings).toHaveLength(0);
  });

  test("scope with env interpolation works", () => {
    const yaml = `
name: test-agent
version: "0.1.0"
model: test-model

scope:
  filesystem:
    root: \${ROOT_PATH}
  memory:
    namespace: \${AGENT_NS:-default-ns}
`;
    const result = loadManifestFromString(yaml, {
      ROOT_PATH: "/custom/workspace",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const scope = result.value.manifest.scope as ManifestScopeConfig;
    expect(scope.filesystem?.root).toBe("/custom/workspace");
    expect(scope.memory?.namespace).toBe("default-ns");
  });

  test("manifest without scope has no scope field", () => {
    const yaml = `
name: test-agent
version: "0.1.0"
model: test-model
`;
    const result = loadManifestFromString(yaml);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.manifest.scope).toBeUndefined();
  });

  test("filesystem scope defaults mode to rw in round-trip", () => {
    const yaml = `
name: test-agent
version: "0.1.0"
model: test-model

scope:
  filesystem:
    root: /workspace
`;
    const result = loadManifestFromString(yaml);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const scope = result.value.manifest.scope as ManifestScopeConfig;
    expect(scope.filesystem?.mode).toBe("rw");
  });
});
