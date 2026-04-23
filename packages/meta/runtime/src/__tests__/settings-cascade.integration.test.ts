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
import { createPermissionBackend, mapSettingsToSourcedRules } from "@koi/permissions";
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

    expect(rules).toHaveLength(1);
    const rule = rules[0];
    expect(rule?.effect).toBe("deny");
    expect(rule?.pattern).toBe("Bash");
    expect(rule?.source).toBe("local");

    const backend = createPermissionBackend({ mode: "default", rules });

    // rule.action is "*" (bare "Bash" → action wildcard), so any action matches
    const query: PermissionQuery = {
      resource: "Bash",
      action: "rm -rf /tmp/test",
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
      action: "src/index.ts",
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

    const backend = createPermissionBackend({
      mode: "default",
      rules: [...userRules, ...projectRules],
    });
    const decision = await backend.check({
      resource: "Bash",
      action: "git status",
      principal: "agent",
    });
    expect(decision.effect).toBe("deny");
  });
});
