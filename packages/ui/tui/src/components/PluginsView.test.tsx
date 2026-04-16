import { describe, expect, it } from "bun:test";
import type { PluginSummary } from "../state/types.js";
import { buildPluginDisplayLines } from "./PluginsView.js";

describe("buildPluginDisplayLines", () => {
  it("returns 'No plugins loaded' when summary is null", () => {
    const lines = buildPluginDisplayLines(null);
    expect(lines).toEqual([{ kind: "info", text: "No plugins loaded." }]);
  });

  it("returns 'No plugins loaded' when loaded array is empty and no errors", () => {
    const summary: PluginSummary = { loaded: [], errors: [] };
    const lines = buildPluginDisplayLines(summary);
    expect(lines).toEqual([{ kind: "info", text: "No plugins loaded." }]);
  });

  it("lists loaded plugins with name, version, and source", () => {
    const summary: PluginSummary = {
      loaded: [
        { name: "hello-plugin", version: "0.0.1", description: "Greets you", source: "user" },
        { name: "audit", version: "1.2.0", description: "Audit logging", source: "managed" },
      ],
      errors: [],
    };
    const lines = buildPluginDisplayLines(summary);
    expect(lines).toEqual([
      { kind: "header", text: "Loaded Plugins (2)" },
      { kind: "plugin", text: "hello-plugin", detail: "v0.0.1 (user) — Greets you" },
      { kind: "plugin", text: "audit", detail: "v1.2.0 (managed) — Audit logging" },
    ]);
  });

  it("includes error lines when errors are present", () => {
    const summary: PluginSummary = {
      loaded: [{ name: "good", version: "1.0.0", description: "Works", source: "user" }],
      errors: [{ plugin: "bad", error: "Invalid hooks.json" }],
    };
    const lines = buildPluginDisplayLines(summary);
    expect(lines).toContainEqual({ kind: "error", text: "bad", detail: "Invalid hooks.json" });
  });

  it("shows only errors when no plugins loaded but errors exist", () => {
    const summary: PluginSummary = {
      loaded: [],
      errors: [{ plugin: "broken", error: "Parse error" }],
    };
    const lines = buildPluginDisplayLines(summary);
    expect(lines).toEqual([
      { kind: "header", text: "Errors (1)" },
      { kind: "error", text: "broken", detail: "Parse error" },
    ]);
  });
});
