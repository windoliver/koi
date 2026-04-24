/**
 * Integration test: settings cascade → permission enforcement.
 *
 * Verifies that a deny rule in `.koi/settings.local.json` is loaded by
 * `loadSettings`, converted to SourcedRules by `mapSettingsToSourcedRules`,
 * fed to `createPermissionBackend`, and results in a denied permission decision
 * for the matching tool.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PermissionQuery } from "@koi/core";
import {
  createPermissionBackend,
  mapSettingsToSourcedRules,
  SOURCE_PRECEDENCE,
  widenCommandScopedRulesForTui,
} from "@koi/permissions";
import { loadSettings } from "@koi/settings";

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "koi-settings-integration-"));
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("settings cascade → permission enforcement", () => {
  test("deny rule in .koi/settings.local.json blocks matching tool", async () => {
    const koiDir = join(tmpDir, ".koi");
    mkdirSync(koiDir, { recursive: true });
    writeFileSync(
      join(koiDir, "settings.local.json"),
      JSON.stringify({
        permissions: {
          deny: ["Bash"],
        },
      }),
    );

    const { settings, errors, sources } = await loadSettings({
      cwd: tmpDir,
      homeDir: join(tmpDir, "home"),
      layers: ["local"],
    });

    expect(errors).toHaveLength(0);
    expect(sources.local).not.toBeNull();
    expect(settings.permissions?.deny).toEqual(["Bash"]);

    const layers = ["user", "project", "local", "flag", "policy"] as const;
    const rules = layers.flatMap((layer) => {
      const layerSettings = sources[layer];
      return layerSettings != null ? mapSettingsToSourcedRules(layerSettings, layer) : [];
    });

    // Bare "Bash" emits 2 rules: exact "Bash" + enriched "Bash:**"
    expect(rules).toHaveLength(2);
    const rule = rules[0];
    expect(rule?.effect).toBe("deny");
    // First rule: exact match for plain "Bash"
    expect(rule?.pattern).toBe("Bash");
    expect(rule?.action).toBe("invoke");
    expect(rule?.source).toBe("local");

    const backend = createPermissionBackend({ mode: "default", rules });

    // Middleware always sends action:"invoke"; resource is the tool id (plain or enriched)
    const query: PermissionQuery = {
      resource: "Bash",
      action: "invoke",
      principal: "agent",
    };
    const decision = await backend.check(query);
    expect(decision.effect).toBe("deny");
  });

  test("allow rule in settings permits matching tool", async () => {
    const rules = mapSettingsToSourcedRules(
      { permissions: { allow: ["Read(*)"], defaultMode: "default" } },
      "project",
    );
    const backend = createPermissionBackend({ mode: "default", rules });
    const decision = await backend.check({
      resource: "Read",
      action: "invoke",
      principal: "agent",
    });
    expect(decision.effect).toBe("allow");
  });

  test("local allow overrides project deny (local > project in SOURCE_PRECEDENCE)", async () => {
    const projectRules = mapSettingsToSourcedRules(
      { permissions: { deny: ["Read(*)"] } },
      "project",
    );
    const localRules = mapSettingsToSourcedRules({ permissions: { allow: ["Read(*)"] } }, "local");

    // local has higher precedence than project: local rules come first.
    const backend = createPermissionBackend({
      mode: "default",
      rules: [...localRules, ...projectRules],
    });

    const decision = await backend.check({
      resource: "Read",
      action: "invoke",
      principal: "agent",
    });
    expect(decision.effect).toBe("allow");
  });

  test("layers cascade: project deny overrides user allow for same tool", async () => {
    const userRules = mapSettingsToSourcedRules(
      { permissions: { allow: ["Bash(git *)"] } },
      "user",
    );
    const projectRules = mapSettingsToSourcedRules(
      { permissions: { deny: ["Bash(*)"] } },
      "project",
    );

    // Rules must be sorted by SOURCE_PRECEDENCE (highest priority first).
    // project > user, so project rules are evaluated before user rules.
    const backend = createPermissionBackend({
      mode: "default",
      rules: [...projectRules, ...userRules],
    });

    // Enriched resource for "git status" on Bash: "Bash:git status"
    const decision = await backend.check({
      resource: "Bash:git status",
      action: "invoke",
      principal: "agent",
    });
    expect(decision.effect).toBe("deny");
  });

  test("settings deny (any layer) overrides built-in TUI allow (TUI rules are fallback)", async () => {
    // Simulate a built-in TUI allow rule (source: "policy", like TUI_ALLOW_RULES entries)
    const tuiAllowRule = {
      pattern: "Glob**",
      action: "invoke",
      effect: "allow" as const,
      source: "policy" as const,
    };

    // Test with each non-policy layer: all must beat the TUI allow fallback
    for (const layer of ["user", "project", "local", "flag", "policy"] as const) {
      const settingsRules = mapSettingsToSourcedRules({ permissions: { deny: ["Glob"] } }, layer);

      // Runtime ordering: all settings rules first, TUI built-ins as fallback last
      const backend = createPermissionBackend({
        mode: "default",
        rules: [...settingsRules, tuiAllowRule],
      });

      const decision = await backend.check({
        resource: "Glob",
        action: "invoke",
        principal: "agent",
      });
      expect(decision.effect).toBe("deny");
    }
  });

  test("command-scoped deny widened to tool-level in TUI single-key mode (fail-closed)", async () => {
    // Uses the production widenCommandScopedRulesForTui helper (same code createKoiRuntime calls).
    const rawRules = mapSettingsToSourcedRules(
      { permissions: { deny: ["Bash(rm -rf*)"] } },
      "local",
    );
    const { rules: widenedRules, hadCommandScoped } = widenCommandScopedRulesForTui(rawRules);
    expect(hadCommandScoped).toBe(true);

    const backend = createPermissionBackend({ mode: "default", rules: widenedRules });
    const decision = await backend.check({
      resource: "Bash",
      action: "invoke",
      principal: "agent",
    });
    expect(decision.effect).toBe("deny");
  });

  test("full production chain: settings file → widenCommandScopedRulesForTui → backend denies Bash", async () => {
    // Exercises loadSettings → mapSettingsToSourcedRules → widenCommandScopedRulesForTui
    // → createPermissionBackend — the same sequence createKoiRuntime now calls.
    const chainCwd = join(tmpDir, "chain-cwd");
    mkdirSync(join(chainCwd, ".koi"), { recursive: true });
    writeFileSync(
      join(chainCwd, ".koi", "settings.local.json"),
      JSON.stringify({ permissions: { deny: ["Bash(rm -rf*)"] } }),
    );

    const { sources } = await loadSettings({ cwd: chainCwd, layers: ["local"] });

    const settingsRules = SOURCE_PRECEDENCE.flatMap((source) => {
      const layerSettings = sources[source];
      return layerSettings != null ? mapSettingsToSourcedRules(layerSettings, source) : [];
    });

    const { rules: widenedRules, hadCommandScoped } = widenCommandScopedRulesForTui(settingsRules);
    expect(hadCommandScoped).toBe(true);

    const backend = createPermissionBackend({ mode: "default", rules: widenedRules });
    const decision = await backend.check({
      resource: "Bash",
      action: "invoke",
      principal: "agent",
    });
    expect(decision.effect).toBe("deny");
  });
});
