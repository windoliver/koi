/**
 * Integration tests for non-tool bricks: forge_middleware, forge_channel
 * + scope enforcement + configSchema.
 *
 * Covers:
 * 1. Middleware: forge → promote scope → ComponentProvider loads it
 * 2. Channel: forge → promote scope → ComponentProvider loads it
 * 3. Sandbox policy: forged middleware has sandbox:false (middleware not sandbox-required)
 * 4. Lifecycle enforcement: deprecated middleware is skipped by ComponentProvider
 * 5. Zone-scoped filtering for middleware
 * 6. Requires enforcement: brick with missing env skipped by ComponentProvider
 * 7. Config schema: forged middleware with configSchema is stored and retrievable
 */

import { describe, expect, test } from "bun:test";
import type {
  Agent,
  AgentManifest,
  AttachResult,
  ImplementationArtifact,
  ProcessId,
  SandboxExecutor,
} from "@koi/core";
import { agentId, channelToken, isAttachResult, middlewareToken } from "@koi/core";
import type { ForgeDeps } from "@koi/forge-tools";
import {
  createForgeChannelTool,
  createForgeComponentProvider,
  createForgeMiddlewareTool,
  createInMemoryForgeStore,
  createPromoteForgeTool,
} from "@koi/forge-tools";
import type { ForgeContext, ForgeResult, PromoteResult } from "@koi/forge-types";
import { createDefaultForgeConfig } from "@koi/forge-types";
import { createForgePipeline } from "../create-forge-stack.js";

function mockExecutor(): SandboxExecutor {
  return {
    execute: async (_code, input, _timeout) => ({
      ok: true,
      value: { output: input, durationMs: 1 },
    }),
  };
}

/** Extract ReadonlyMap from attach() result (handles both AttachResult and bare Map). */
function extractMap(
  result: AttachResult | ReadonlyMap<string, unknown>,
): ReadonlyMap<string, unknown> {
  return isAttachResult(result) ? result.components : result;
}

function stubAgent(): Agent {
  const pid: ProcessId = {
    id: agentId("agent-test"),
    name: "test",
    type: "worker",
    depth: 0,
  };
  return {
    pid,
    manifest: { name: "test", version: "0.0.0" } as AgentManifest,
    state: "running",
    component: () => undefined,
    has: () => false,
    hasAll: () => false,
    query: () => new Map(),
    components: () => new Map(),
  };
}

function createDeps(overrides?: Partial<ForgeDeps>): ForgeDeps {
  const store = createInMemoryForgeStore();
  const executor = mockExecutor();
  const context: ForgeContext = {
    agentId: "agent-int",
    depth: 0,
    sessionId: "session-int",
    forgesThisSession: 0,
  };
  return {
    store,
    executor,
    verifiers: [],
    config: createDefaultForgeConfig({
      scopePromotion: { requireHumanApproval: false },
    }),
    context,
    pipeline: createForgePipeline(),
    ...overrides,
  };
}

describe("Forge non-tool bricks — integration", () => {
  test("middleware: forge → promote scope → ComponentProvider loads it", async () => {
    const deps = createDeps();

    // Step 1: Forge middleware
    const forgeMw = createForgeMiddlewareTool(deps);
    const forgeResult = (await forgeMw.execute({
      name: "auditMiddleware",
      description: "Logs all model calls for audit",
      implementation: "return { beforeModel: async (ctx) => ctx };",
    })) as { readonly ok: true; readonly value: ForgeResult };

    expect(forgeResult.ok).toBe(true);
    expect(forgeResult.value.kind).toBe("middleware");

    // Step 2: Promote scope to zone
    const promoteTool = createPromoteForgeTool(deps);
    const promoteResult = (await promoteTool.execute({
      brickId: forgeResult.value.id,
      targetScope: "zone",
    })) as { readonly ok: true; readonly value: PromoteResult };

    expect(promoteResult.ok).toBe(true);
    expect(promoteResult.value.applied).toBe(true);

    // Step 3: ComponentProvider should load the middleware
    const provider = createForgeComponentProvider({ store: deps.store, executor: deps.executor });
    const components = extractMap(await provider.attach(stubAgent()));

    const tok = middlewareToken("auditMiddleware") as string;
    expect(components.has(tok)).toBe(true);

    const brick = components.get(tok) as ImplementationArtifact;
    expect(brick.kind).toBe("middleware");
    expect(brick.implementation).toBe("return { beforeModel: async (ctx) => ctx };");

    provider.dispose();
  });

  test("channel: forge → promote scope → ComponentProvider loads it", async () => {
    const deps = createDeps();

    // Step 1: Forge channel
    const forgeCh = createForgeChannelTool(deps);
    const forgeResult = (await forgeCh.execute({
      name: "slackChannel",
      description: "Slack I/O adapter",
      implementation: "return { send: async () => {}, onMessage: () => () => {} };",
    })) as { readonly ok: true; readonly value: ForgeResult };

    expect(forgeResult.ok).toBe(true);
    expect(forgeResult.value.kind).toBe("channel");

    // Step 2: Promote scope to zone
    const promoteTool = createPromoteForgeTool(deps);
    const promoteResult = (await promoteTool.execute({
      brickId: forgeResult.value.id,
      targetScope: "zone",
    })) as { readonly ok: true; readonly value: PromoteResult };

    expect(promoteResult.ok).toBe(true);
    expect(promoteResult.value.applied).toBe(true);

    // Step 3: ComponentProvider loads the channel
    const provider = createForgeComponentProvider({ store: deps.store, executor: deps.executor });
    const components = extractMap(await provider.attach(stubAgent()));

    const tok = channelToken("slackChannel") as string;
    expect(components.has(tok)).toBe(true);

    const brick = components.get(tok) as ImplementationArtifact;
    expect(brick.kind).toBe("channel");

    provider.dispose();
  });

  test("sandbox policy: forged middleware is loaded regardless of sandbox status", async () => {
    const deps = createDeps();

    const forgeMw = createForgeMiddlewareTool(deps);
    const forgeResult = (await forgeMw.execute({
      name: "sandboxedMw",
      description: "Middleware with default sandbox policy",
      implementation: "return {};",
    })) as { readonly ok: true; readonly value: ForgeResult };

    expect(forgeResult.ok).toBe(true);
    // Forged bricks default to sandbox: true (from ForgeConfig.defaultPolicy)
    expect(forgeResult.value.policy.sandbox).toBe(true);

    // ComponentProvider loads middleware regardless of sandbox status
    // (SANDBOX_REQUIRED_BY_KIND.middleware === false, so sandbox check is skipped)
    const provider = createForgeComponentProvider({ store: deps.store, executor: deps.executor });
    const components = extractMap(await provider.attach(stubAgent()));
    expect(components.has(middlewareToken("sandboxedMw") as string)).toBe(true);

    provider.dispose();
  });

  test("lifecycle enforcement: deprecated middleware is skipped by ComponentProvider", async () => {
    const deps = createDeps();

    const forgeMw = createForgeMiddlewareTool(deps);
    const forgeResult = (await forgeMw.execute({
      name: "deprecatedMw",
      description: "Middleware that will be deprecated",
      implementation: "return {};",
    })) as { readonly ok: true; readonly value: ForgeResult };

    expect(forgeResult.ok).toBe(true);

    // Deprecate the brick via lifecycle change
    const promoteTool = createPromoteForgeTool(deps);
    await promoteTool.execute({
      brickId: forgeResult.value.id,
      targetLifecycle: "deprecated",
    });

    // ComponentProvider should skip deprecated middleware
    const provider = createForgeComponentProvider({ store: deps.store, executor: deps.executor });
    const components = extractMap(await provider.attach(stubAgent()));
    expect(components.has(middlewareToken("deprecatedMw") as string)).toBe(false);

    provider.dispose();
  });

  test("zone-scoped middleware only visible to matching zone", async () => {
    const deps = createDeps({
      config: createDefaultForgeConfig({ defaultScope: "zone" }),
    });

    // Forge middleware with zone scope + zone tag
    const forgeMw = createForgeMiddlewareTool(deps);
    const forgeResult = (await forgeMw.execute({
      name: "zonedMiddleware",
      description: "Zone-scoped middleware",
      implementation: "return {};",
      tags: ["zone:team-alpha"],
    })) as { readonly ok: true; readonly value: ForgeResult };

    expect(forgeResult.ok).toBe(true);

    // ComponentProvider with matching zone sees it
    const providerMatch = createForgeComponentProvider({
      store: deps.store,
      executor: deps.executor,
      zoneId: "team-alpha",
    });
    const componentsMatch = extractMap(await providerMatch.attach(stubAgent()));
    expect(componentsMatch.has(middlewareToken("zonedMiddleware") as string)).toBe(true);
    providerMatch.dispose();

    // ComponentProvider with different zone does NOT see it
    const providerOther = createForgeComponentProvider({
      store: deps.store,
      executor: deps.executor,
      zoneId: "team-beta",
    });
    const componentsOther = extractMap(await providerOther.attach(stubAgent()));
    expect(componentsOther.has(middlewareToken("zonedMiddleware") as string)).toBe(false);
    providerOther.dispose();
  });

  test("requires enforcement: brick with missing env is skipped by ComponentProvider", async () => {
    const deps = createDeps();

    // Forge middleware with an env requirement that won't be satisfied
    const forgeMw = createForgeMiddlewareTool(deps);
    const forgeResult = (await forgeMw.execute({
      name: "requiresMiddleware",
      description: "Middleware with unsatisfied env requirement",
      implementation: "return {};",
      requires: { env: ["__KOI_NONEXISTENT_ENV_VAR_XYZ__"] },
    })) as { readonly ok: true; readonly value: ForgeResult };

    expect(forgeResult.ok).toBe(true);

    // ComponentProvider should skip this brick due to unsatisfied requires
    const provider = createForgeComponentProvider({ store: deps.store, executor: deps.executor });
    const components = extractMap(await provider.attach(stubAgent()));

    const tok = middlewareToken("requiresMiddleware") as string;
    expect(components.has(tok)).toBe(false);

    provider.dispose();
  });

  test("config schema: forged middleware with configSchema is stored and retrievable", async () => {
    const deps = createDeps();

    const forgeMw = createForgeMiddlewareTool(deps);
    const forgeResult = (await forgeMw.execute({
      name: "configuredMw",
      description: "Middleware with config schema",
      implementation: "return {};",
      configSchema: {
        type: "object",
        properties: {
          logLevel: { type: "string" },
          enabled: { type: "boolean" },
        },
      },
    })) as { readonly ok: true; readonly value: ForgeResult };

    expect(forgeResult.ok).toBe(true);

    // Load from store and verify configSchema is persisted
    const loadResult = await deps.store.load(forgeResult.value.id);
    expect(loadResult.ok).toBe(true);
    if (loadResult.ok) {
      expect(loadResult.value.configSchema).toEqual({
        type: "object",
        properties: {
          logLevel: { type: "string" },
          enabled: { type: "boolean" },
        },
      });
    }
  });
});
