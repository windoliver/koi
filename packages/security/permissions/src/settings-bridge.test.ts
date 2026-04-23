import { describe, expect, test } from "bun:test";
import type { KoiSettings } from "@koi/settings";
import { mapSettingsToSourcedRules } from "./settings-bridge.js";

describe("mapSettingsToSourcedRules", () => {
  test("empty permissions returns empty array", () => {
    const rules = mapSettingsToSourcedRules({}, "user");
    expect(rules).toHaveLength(0);
  });

  test("allow strings become SourcedRules with effect=allow", () => {
    const settings: KoiSettings = {
      permissions: { allow: ["Read(*)", "Glob(*)"] },
    };
    const rules = mapSettingsToSourcedRules(settings, "user");
    const allowRules = rules.filter((r) => r.effect === "allow");
    expect(allowRules).toHaveLength(2);
    expect(allowRules[0]?.pattern).toBe("Read");
    expect(allowRules[0]?.action).toBe("*");
    expect(allowRules[0]?.source).toBe("user");
  });

  test("deny strings become SourcedRules with effect=deny", () => {
    const settings: KoiSettings = {
      permissions: { deny: ["Bash(rm -rf*)"] },
    };
    const rules = mapSettingsToSourcedRules(settings, "local");
    expect(rules[0]?.effect).toBe("deny");
    expect(rules[0]?.pattern).toBe("Bash");
    expect(rules[0]?.action).toBe("rm -rf*");
    expect(rules[0]?.source).toBe("local");
  });

  test("ask strings become SourcedRules with effect=ask", () => {
    const settings: KoiSettings = {
      permissions: { ask: ["Bash(git push*)"] },
    };
    const rules = mapSettingsToSourcedRules(settings, "project");
    expect(rules[0]?.effect).toBe("ask");
    expect(rules[0]?.action).toBe("git push*");
  });

  test("bare tool name (no parens) uses action='*'", () => {
    const settings: KoiSettings = {
      permissions: { deny: ["WebFetch"] },
    };
    const rules = mapSettingsToSourcedRules(settings, "policy");
    expect(rules[0]?.pattern).toBe("WebFetch");
    expect(rules[0]?.action).toBe("*");
  });

  test("wildcard '*' becomes pattern='*' action='*'", () => {
    const settings: KoiSettings = {
      permissions: { allow: ["*"] },
    };
    const rules = mapSettingsToSourcedRules(settings, "flag");
    expect(rules[0]?.pattern).toBe("*");
    expect(rules[0]?.action).toBe("*");
  });

  test("source is preserved on all rules", () => {
    const settings: KoiSettings = {
      permissions: {
        allow: ["Read(*)"],
        deny: ["Bash(*)"],
        ask: ["WebFetch(*)"],
      },
    };
    const rules = mapSettingsToSourcedRules(settings, "project");
    expect(rules.every((r) => r.source === "project")).toBe(true);
  });
});
