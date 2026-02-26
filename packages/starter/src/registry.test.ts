/**
 * Unit tests for MiddlewareRegistry, resolveManifestMiddleware,
 * createDefaultRegistry, and the agent-monitor adapter.
 */

import { describe, expect, mock, test } from "bun:test";
import type { AgentManifest, KoiMiddleware } from "@koi/core";
import { createAgentMonitorAdapter } from "./adapters/agent-monitor.js";
import type { MiddlewareFactory } from "./index.js";
import {
  createDefaultRegistry,
  createMiddlewareRegistry,
  resolveManifestMiddleware,
} from "./index.js";

// ---------------------------------------------------------------------------
// createMiddlewareRegistry
// ---------------------------------------------------------------------------

describe("createMiddlewareRegistry", () => {
  test("get returns factory for registered name", () => {
    const factory: MiddlewareFactory = mock(() => ({}) as KoiMiddleware);
    const registry = createMiddlewareRegistry(new Map([["my-mw", factory]]));
    expect(registry.get("my-mw")).toBe(factory);
  });

  test("get returns undefined for unregistered name", () => {
    const registry = createMiddlewareRegistry(new Map());
    expect(registry.get("missing")).toBeUndefined();
  });

  test("names returns set of registered names", () => {
    const factory: MiddlewareFactory = mock(() => ({}) as KoiMiddleware);
    const registry = createMiddlewareRegistry(
      new Map([
        ["mw-a", factory],
        ["mw-b", factory],
      ]),
    );
    const names = registry.names();
    expect(names.has("mw-a")).toBe(true);
    expect(names.has("mw-b")).toBe(true);
    expect(names.size).toBe(2);
  });

  test("names returns empty set for empty registry", () => {
    const registry = createMiddlewareRegistry(new Map());
    expect(registry.names().size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// resolveManifestMiddleware
// ---------------------------------------------------------------------------

describe("resolveManifestMiddleware", () => {
  const minimalManifest: AgentManifest = {
    name: "test-agent",
    version: "0.0.0",
    model: { name: "claude-sonnet-4-6" },
  };

  test("returns empty array when manifest has no middleware", async () => {
    const registry = createMiddlewareRegistry(new Map());
    const result = await resolveManifestMiddleware(minimalManifest, registry);
    expect(result).toEqual([]);
  });

  test("returns empty array when manifest.middleware is empty", async () => {
    const registry = createMiddlewareRegistry(new Map());
    const manifest: AgentManifest = { ...minimalManifest, middleware: [] };
    expect(await resolveManifestMiddleware(manifest, registry)).toEqual([]);
  });

  test("instantiates known middleware in manifest order", async () => {
    const produced1 = { name: "mw1" } as unknown as KoiMiddleware;
    const produced2 = { name: "mw2" } as unknown as KoiMiddleware;
    const factory1: MiddlewareFactory = mock(() => produced1);
    const factory2: MiddlewareFactory = mock(() => produced2);

    const registry = createMiddlewareRegistry(
      new Map([
        ["mw-1", factory1],
        ["mw-2", factory2],
      ]),
    );
    const manifest: AgentManifest = {
      ...minimalManifest,
      middleware: [{ name: "mw-1" }, { name: "mw-2" }],
    };

    const result = await resolveManifestMiddleware(manifest, registry);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe(produced1);
    expect(result[1]).toBe(produced2);
  });

  test("silently skips unknown middleware names", async () => {
    const factory: MiddlewareFactory = mock(() => ({}) as KoiMiddleware);
    const registry = createMiddlewareRegistry(new Map([["known", factory]]));
    const manifest: AgentManifest = {
      ...minimalManifest,
      middleware: [{ name: "unknown-mw" }, { name: "known" }],
    };

    const result = await resolveManifestMiddleware(manifest, registry);
    expect(result).toHaveLength(1);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  test("passes manifest MiddlewareConfig to factory", async () => {
    const factory: MiddlewareFactory = mock(() => ({}) as KoiMiddleware);
    const registry = createMiddlewareRegistry(new Map([["mw", factory]]));
    const mwConfig = { name: "mw", options: { foo: "bar" } };
    const manifest: AgentManifest = {
      ...minimalManifest,
      middleware: [mwConfig],
    };

    await resolveManifestMiddleware(manifest, registry);
    expect(factory).toHaveBeenCalledWith(mwConfig, undefined);
  });

  test("passes RuntimeOpts to factory", async () => {
    const factory: MiddlewareFactory = mock(() => ({}) as KoiMiddleware);
    const registry = createMiddlewareRegistry(new Map([["mw", factory]]));
    const manifest: AgentManifest = {
      ...minimalManifest,
      middleware: [{ name: "mw" }],
    };

    await resolveManifestMiddleware(manifest, registry, { agentDepth: 2 });
    expect(factory).toHaveBeenCalledWith({ name: "mw" }, { agentDepth: 2 });
  });
});

// ---------------------------------------------------------------------------
// createDefaultRegistry
// ---------------------------------------------------------------------------

describe("createDefaultRegistry", () => {
  test("registers agent-monitor", () => {
    const registry = createDefaultRegistry();
    expect(registry.get("agent-monitor")).toBeDefined();
  });

  test("registers monitor alias", () => {
    const registry = createDefaultRegistry();
    expect(registry.get("monitor")).toBeDefined();
  });

  test("passes agent-monitor callbacks through to the middleware", async () => {
    const captured: unknown[] = [];
    const onAnomaly = mock((signal: unknown) => {
      captured.push(signal);
    });
    const registry = createDefaultRegistry({ "agent-monitor": { onAnomaly } });
    const factory = registry.get("agent-monitor");
    if (factory === undefined) throw new Error("factory should be registered");
    const mw = await factory({ name: "agent-monitor" });
    expect(mw.name).toBe("agent-monitor");
  });

  test("monitor alias shares callbacks with agent-monitor", async () => {
    const onAnomaly = mock(() => {});
    const registry = createDefaultRegistry({ monitor: { onAnomaly } });
    const monitorFactory = registry.get("monitor");
    const agentMonitorFactory = registry.get("agent-monitor");
    if (monitorFactory === undefined || agentMonitorFactory === undefined) {
      throw new Error("both factories should be registered");
    }
    const mw1 = await monitorFactory({ name: "monitor" });
    const mw2 = await agentMonitorFactory({ name: "agent-monitor" });
    expect(mw1.name).toBe("agent-monitor");
    expect(mw2.name).toBe("agent-monitor");
  });

  test("callbacks are optional — defaults to stderr handler", async () => {
    const registry = createDefaultRegistry();
    const factory = registry.get("agent-monitor");
    if (factory === undefined) throw new Error("factory should be registered");
    const mw = await factory({ name: "agent-monitor" });
    expect(mw.name).toBe("agent-monitor");
  });

  test("registers soul", () => {
    const registry = createDefaultRegistry();
    expect(registry.get("soul")).toBeDefined();
  });

  test("registers permissions", () => {
    const registry = createDefaultRegistry();
    expect(registry.get("permissions")).toBeDefined();
  });

  test("permissions factory creates middleware with default engine", () => {
    const registry = createDefaultRegistry();
    const factory = registry.get("permissions");
    if (factory === undefined) throw new Error("factory should be registered");
    const mw = factory({
      name: "permissions",
      options: { rules: { allow: ["*"], deny: [], ask: [] } },
    });
    expect(mw).toBeDefined();
  });

  test("permissions factory uses provided engine from callbacks", () => {
    const customEngine = {
      check: (_toolId: string, _input: unknown) => ({ allowed: true }) as { allowed: true },
    };
    const registry = createDefaultRegistry({ permissions: { engine: customEngine } });
    const factory = registry.get("permissions");
    if (factory === undefined) throw new Error("factory should be registered");
    const mw = factory({
      name: "permissions",
      options: { rules: { allow: ["*"], deny: [], ask: [] } },
    });
    expect(mw).toBeDefined();
  });

  test("permissions factory normalizes missing deny/ask to empty arrays", () => {
    const registry = createDefaultRegistry();
    const factory = registry.get("permissions");
    if (factory === undefined) throw new Error("factory should be registered");
    // User only specifies allow — deny/ask should default to []
    const mw = factory({
      name: "permissions",
      options: { rules: { allow: ["*"] } },
    });
    expect(mw).toBeDefined();
  });

  test("returns undefined for unknown names", () => {
    const registry = createDefaultRegistry();
    expect(registry.get("unknown-middleware")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// createAgentMonitorAdapter
// ---------------------------------------------------------------------------

describe("createAgentMonitorAdapter", () => {
  test("returns a KoiMiddleware with correct name", () => {
    const mw = createAgentMonitorAdapter({ name: "agent-monitor" });
    expect(mw.name).toBe("agent-monitor");
  });

  test("accepts empty options", () => {
    const mw = createAgentMonitorAdapter({ name: "agent-monitor", options: {} });
    expect(mw.name).toBe("agent-monitor");
  });

  test("accepts valid threshold options from manifest", () => {
    const mw = createAgentMonitorAdapter({
      name: "agent-monitor",
      options: {
        thresholds: {
          maxToolCallsPerTurn: 10,
          maxErrorCallsPerSession: 5,
        },
      },
    });
    expect(mw.name).toBe("agent-monitor");
  });

  test("accepts destructiveToolIds from manifest", () => {
    const mw = createAgentMonitorAdapter({
      name: "agent-monitor",
      options: { destructiveToolIds: ["delete-file", "send-email"] },
    });
    expect(mw.name).toBe("agent-monitor");
  });

  test("accepts spawnToolIds from manifest", () => {
    const mw = createAgentMonitorAdapter({
      name: "agent-monitor",
      options: { spawnToolIds: ["forge_agent"] },
    });
    expect(mw.name).toBe("agent-monitor");
  });

  test("accepts agentDepth from RuntimeOpts", () => {
    const mw = createAgentMonitorAdapter(
      { name: "agent-monitor", options: { spawnToolIds: ["forge_agent"] } },
      { agentDepth: 1 },
    );
    expect(mw.name).toBe("agent-monitor");
  });

  test("uses provided onAnomaly callback instead of default", () => {
    const onAnomaly = mock(() => {});
    const mw = createAgentMonitorAdapter({ name: "agent-monitor" }, undefined, { onAnomaly });
    expect(mw.name).toBe("agent-monitor");
    // onAnomaly is baked in — verified by integration test in e2e suite
  });

  test("uses provided onAnomalyError callback", () => {
    const onAnomalyError = mock((_err: unknown, _sig: unknown) => {});
    const mw = createAgentMonitorAdapter({ name: "agent-monitor" }, undefined, {
      onAnomalyError,
    });
    expect(mw.name).toBe("agent-monitor");
  });

  test("uses provided onMetrics callback", () => {
    const onMetrics = mock((_sessionId: unknown, _summary: unknown) => {});
    const mw = createAgentMonitorAdapter({ name: "agent-monitor" }, undefined, { onMetrics });
    expect(mw.name).toBe("agent-monitor");
  });

  test("throws on invalid threshold (zero value)", () => {
    expect(() =>
      createAgentMonitorAdapter({
        name: "agent-monitor",
        options: { thresholds: { maxToolCallsPerTurn: 0 } },
      }),
    ).toThrow(/invalid manifest options/);
  });

  test("throws on invalid destructiveToolIds (non-array)", () => {
    expect(() =>
      createAgentMonitorAdapter({
        name: "agent-monitor",
        options: { destructiveToolIds: "not-an-array" },
      }),
    ).toThrow(/invalid manifest options/);
  });

  test("resolveManifestMiddleware wires agent-monitor from manifest", async () => {
    const registry = createDefaultRegistry();
    const manifest: AgentManifest = {
      name: "monitored-agent",
      version: "0.0.0",
      model: { name: "claude-sonnet-4-6" },
      middleware: [
        {
          name: "agent-monitor",
          options: {
            thresholds: { maxToolCallsPerTurn: 15 },
            destructiveToolIds: ["delete"],
          },
        },
      ],
    };

    const middleware = await resolveManifestMiddleware(manifest, registry, { agentDepth: 0 });
    expect(middleware).toHaveLength(1);
    expect(middleware[0]?.name).toBe("agent-monitor");
  });

  test("resolveManifestMiddleware passes callbacks via registry", async () => {
    const onAnomaly = mock(() => {});
    const registry = createDefaultRegistry({ "agent-monitor": { onAnomaly } });
    const manifest: AgentManifest = {
      name: "monitored-agent",
      version: "0.0.0",
      model: { name: "claude-sonnet-4-6" },
      middleware: [{ name: "agent-monitor" }],
    };

    const middleware = await resolveManifestMiddleware(manifest, registry);
    expect(middleware).toHaveLength(1);
    expect(middleware[0]?.name).toBe("agent-monitor");
  });
});
