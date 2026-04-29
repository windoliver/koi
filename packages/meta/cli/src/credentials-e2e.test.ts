/**
 * Behavioral end-to-end test for the gov-15 credentials scope.
 *
 * Exercises the full production path that the TUI runs at boot:
 *
 *   manifest YAML
 *     → loadManifestConfig (parse + validate)
 *     → buildScopedCredentials (env producer + scope wrapper)
 *     → createProgressiveSkillProvider({ credentials })
 *     → provider.attach(stubAgent)
 *     → AttachResult.{components, skipped}
 *
 * Guards two things at once:
 *   1. A skill whose `requires.credentials.ref` is in the manifest scope
 *      activates — its component appears in the components map.
 *   2. A skill whose ref is OUT of scope is dropped — its component is
 *      absent from the map and an entry appears in `skipped` with a
 *      stable "credentials not in scope" reason. The credential VALUE is
 *      never echoed in the reason.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent } from "@koi/core";
import { isAttachResult, skillToken } from "@koi/core";
import { createProgressiveSkillProvider, createSkillsRuntime } from "@koi/skills-runtime";

import { loadManifestConfig } from "./manifest.js";
import { buildScopedCredentials } from "./shared-wiring.js";

const STUB_AGENT = {} as Agent;

describe("gov-15 credentials scope: manifest → skill activation E2E", () => {
  let workspace: string;
  const previousEnv = { ...process.env };

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "koi-creds-e2e-"));
    mkdirSync(join(workspace, ".claude", "skills"), { recursive: true });
    process.env.KOI_CRED_OPENAI_API_KEY = "sk-secret-shouldnt-leak";
    process.env.KOI_CRED_STRIPE_SECRET = "stripe-secret-shouldnt-leak";
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
    process.env = { ...previousEnv };
  });

  function writeSkill(name: string, ref: string): void {
    const dir = join(workspace, ".claude", "skills", name);
    mkdirSync(dir, { recursive: true });
    const body = [
      "---",
      `name: ${name}`,
      `description: Test ${name}.`,
      "requires:",
      "  credentials:",
      "    primary:",
      "      kind: api_key",
      `      ref: ${ref}`,
      "---",
      "",
      "Body.",
    ].join("\n");
    writeFileSync(join(dir, "SKILL.md"), body);
  }

  function writeManifest(allow: readonly string[]): string {
    const path = join(workspace, "koi.yaml");
    const yaml = [
      "model:",
      "  name: google/gemini-2.0-flash-001",
      "credentials:",
      "  allow:",
      ...allow.map((p) => `    - "${p}"`),
    ].join("\n");
    writeFileSync(path, yaml);
    return path;
  }

  test("in-scope skill activates; out-of-scope skill is dropped with stable reason", async () => {
    writeSkill("cred-allowed", "openai_api_key");
    writeSkill("cred-blocked", "stripe_secret");
    const manifestPath = writeManifest(["openai_*"]);

    // 1. Parse manifest exactly as tui-command does
    const manifestResult = await loadManifestConfig(manifestPath, { skipAuditValidation: true });
    expect(manifestResult.ok).toBe(true);
    if (!manifestResult.ok) return;
    expect(manifestResult.value.credentials).toEqual({ allow: ["openai_*"] });

    // 2. Build the scoped CredentialComponent — the SAME instance that
    // tui-command passes to both the CREDENTIALS provider and the skill
    // provider.
    const credentials = buildScopedCredentials(manifestResult.value.credentials);
    expect(credentials).toBeDefined();
    if (credentials === undefined) return;

    // 3. Create the progressive skill provider with credentials wired
    const skillsRuntime = createSkillsRuntime({
      bundledRoot: null,
      userRoot: join(workspace, ".claude", "skills"),
    });
    const { provider } = createProgressiveSkillProvider(skillsRuntime, { credentials });

    // 4. Attach and inspect
    const result = await provider.attach(STUB_AGENT);
    if (!isAttachResult(result)) throw new Error("expected AttachResult");

    // In-scope skill registered
    expect(result.components.has(skillToken("cred-allowed"))).toBe(true);

    // Out-of-scope skill dropped
    expect(result.components.has(skillToken("cred-blocked"))).toBe(false);
    const blockedSkip = result.skipped.find((s) => s.name === "cred-blocked");
    expect(blockedSkip).toBeDefined();
    expect(blockedSkip?.reason).toContain("credentials not in scope");

    // Credential VALUES are never echoed in the skipped reason — agents
    // and operators reading the skipped list cannot learn whether the env
    // var was set or what its value was.
    expect(blockedSkip?.reason).not.toContain("stripe-secret-shouldnt-leak");
    expect(blockedSkip?.reason).not.toContain("sk-secret-shouldnt-leak");
  });

  test("manifest with no credentials block: every skill activates regardless of refs (backwards-compat)", async () => {
    writeSkill("cred-anywhere", "stripe_secret");
    // No credentials block in this manifest
    const manifestPath = join(workspace, "koi.yaml");
    writeFileSync(manifestPath, ["model:", "  name: google/gemini-2.0-flash-001"].join("\n"));

    const manifestResult = await loadManifestConfig(manifestPath, { skipAuditValidation: true });
    if (!manifestResult.ok) throw new Error(`manifest load failed: ${manifestResult.error}`);
    expect(manifestResult.value.credentials).toBeUndefined();

    const credentials = buildScopedCredentials(manifestResult.value.credentials);
    expect(credentials).toBeUndefined();

    const skillsRuntime = createSkillsRuntime({
      bundledRoot: null,
      userRoot: join(workspace, ".claude", "skills"),
    });
    const { provider } = createProgressiveSkillProvider(skillsRuntime);
    const result = await provider.attach(STUB_AGENT);
    if (!isAttachResult(result)) throw new Error("expected AttachResult");
    expect(result.components.has(skillToken("cred-anywhere"))).toBe(true);
    expect(result.skipped).toHaveLength(0);
  });

  test("empty allow array drops every credentialed skill (closed-by-default semantics)", async () => {
    writeSkill("any-cred", "openai_api_key");
    const manifestPath = join(workspace, "koi.yaml");
    writeFileSync(
      manifestPath,
      ["model:", "  name: google/gemini-2.0-flash-001", "credentials:", "  allow: []"].join("\n"),
    );

    const manifestResult = await loadManifestConfig(manifestPath, { skipAuditValidation: true });
    if (!manifestResult.ok) throw new Error(`manifest load failed: ${manifestResult.error}`);
    // gov-15: explicit empty allow is preserved as a present-but-empty
    // declaration so downstream wiring builds a deny-all
    // CredentialComponent. Skills with `requires.credentials` are dropped
    // to `skipped`; only skills with no credential block remain visible.
    expect(manifestResult.value.credentials).toEqual({ allow: [] });

    const credentials = buildScopedCredentials(manifestResult.value.credentials);
    if (credentials === undefined) {
      throw new Error("expected deny-all CredentialComponent for explicit empty allow");
    }
    const skillsRuntime = createSkillsRuntime({
      bundledRoot: null,
      userRoot: join(workspace, ".claude", "skills"),
    });
    const { provider } = createProgressiveSkillProvider(skillsRuntime, { credentials });
    const result = await provider.attach(STUB_AGENT);
    if (!isAttachResult(result)) throw new Error("expected AttachResult");
    expect(result.components.has(skillToken("any-cred"))).toBe(false);
    expect(result.skipped.find((s) => s.name === "any-cred")?.reason).toBeDefined();
  });
});
