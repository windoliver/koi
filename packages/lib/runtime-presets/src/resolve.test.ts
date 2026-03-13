import { describe, expect, test } from "bun:test";
import { ADDONS } from "./addons.js";
import { getPreset, PRESET_IDS, resolveAddons, resolveRuntimePreset } from "./resolve.js";

describe("getPreset", () => {
  test("returns local preset for 'local'", () => {
    const preset = getPreset("local");
    expect(preset.id).toBe("local");
    expect(preset.nexusMode).toBe("embed-lite");
  });

  test("returns demo preset for 'demo'", () => {
    const preset = getPreset("demo");
    expect(preset.id).toBe("demo");
    expect(preset.nexusMode).toBe("embed-auth");
    expect(preset.demoPack).toBe("connected");
  });

  test("returns mesh preset for 'mesh'", () => {
    const preset = getPreset("mesh");
    expect(preset.id).toBe("mesh");
    expect(preset.services.gateway).toBe(true);
    expect(preset.services.node).toBe("full");
  });
});

describe("PRESET_IDS", () => {
  test("contains all three preset IDs", () => {
    expect(PRESET_IDS).toEqual(["local", "demo", "mesh"]);
  });
});

describe("resolveRuntimePreset", () => {
  test("resolves local preset without overrides", () => {
    const result = resolveRuntimePreset("local");
    expect(result.preset).toBe("local");
    expect(result.resolved).toBeDefined();
  });

  test("resolves demo preset", () => {
    const result = resolveRuntimePreset("demo");
    expect(result.preset).toBe("demo");
  });
});

describe("resolveAddons", () => {
  test("resolves known add-on IDs", () => {
    const result = resolveAddons(["telegram", "slack"]);
    expect(result.addons).toHaveLength(2);
    expect(result.unknown).toHaveLength(0);
    expect(result.addons[0]?.id).toBe("telegram");
    expect(result.addons[1]?.id).toBe("slack");
  });

  test("reports unknown add-on IDs", () => {
    const result = resolveAddons(["telegram", "unknown-addon"]);
    expect(result.addons).toHaveLength(1);
    expect(result.unknown).toEqual(["unknown-addon"]);
  });

  test("handles empty array", () => {
    const result = resolveAddons([]);
    expect(result.addons).toHaveLength(0);
    expect(result.unknown).toHaveLength(0);
  });
});

describe("ADDONS", () => {
  test("telegram add-on has correct structure", () => {
    const addon = ADDONS.telegram;
    expect(addon).toBeDefined();
    expect(addon?.channelName).toBe("@koi/channel-telegram");
    expect(addon?.envKeys).toHaveLength(1);
  });

  test("slack add-on requires two env keys", () => {
    const addon = ADDONS.slack;
    expect(addon).toBeDefined();
    expect(addon?.envKeys).toHaveLength(2);
  });

  test("temporal add-on has no channel", () => {
    const addon = ADDONS.temporal;
    expect(addon).toBeDefined();
    expect(addon?.channelName).toBeUndefined();
  });
});
