/**
 * Integration tests for non-tool bricks: forge_middleware, forge_channel
 * + requires enforcement + configSchema.
 *
 * Covers:
 * 1. Middleware: forge → promote → ComponentProvider loads it
 * 2. Channel: forge → promote → ComponentProvider loads it
 * 3. Trust enforcement: verified middleware skipped by ComponentProvider
 * 4. Trust enforcement after promotion: promoted middleware loaded
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
import { createDefaultForgeConfig } from "../config.js";
import { createForgeComponentProvider } from "../forge-component-provider.js";
import { createInMemoryForgeStore } from "../memory-store.js";
import { createForgeChannelTool } from "../tools/forge-channel.js";
import { createForgeMiddlewareTool } from "../tools/forge-middleware.js";
import { createPromoteForgeTool } from "../tools/promote-forge.js";
import type { ForgeDeps } from "../tools/shared.js";
import type { ForgeContext, ForgeResult, PromoteResult } from "../types.js";

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

describe("Forge non-tool bricks — integration", () => {
  test("middleware: forge → promote to promoted → ComponentProvider loads it", async () => {
    const store = createInMemoryForgeStore();
    const executor = mockExecutor();
    const context: ForgeContext = {
      agentId: "agent-int",
      depth: 0,
      sessionId: "session-int",
      forgesThisSession: 0,
    };
    const config = createDefaultForgeConfig();
    const deps: ForgeDeps = { store, executor, verifiers: [], config, context };

    // Step 1: Forge middleware (starts at "sandbox" trust)
    const forgeMw = createForgeMiddlewareTool(deps);
    const forgeResult = (await forgeMw.execute({
      name: "auditMiddleware",
      description: "Logs all model calls for audit",
      implementation: "return { beforeModel: async (ctx) => ctx };",
    })) as { readonly ok: true; readonly value: ForgeResult };

    expect(forgeResult.ok).toBe(true);
    expect(forgeResult.value.kind).toBe("middleware");
    expect(forgeResult.value.trustTier).toBe("sandbox");

    // Step 2: Promote to "promoted" trust tier
    const promoteTool = createPromoteForgeTool(deps);
    const promoteResult = (await promoteTool.execute({
      brickId: forgeResult.value.id,
      targetTrustTier: "promoted",
    })) as { readonly ok: true; readonly value: PromoteResult };

    expect(promoteResult.ok).toBe(true);
    expect(promoteResult.value.applied).toBe(true);

    // Step 3: ComponentProvider should load the promoted middleware
    const provider = createForgeComponentProvider({ store, executor });
    const components = extractMap(await provider.attach(stubAgent()));

    const tok = middlewareToken("auditMiddleware") as string;
    expect(components.has(tok)).toBe(true);

    const brick = components.get(tok) as ImplementationArtifact;
    expect(brick.kind).toBe("middleware");
    expect(brick.implementation).toBe("return { beforeModel: async (ctx) => ctx };");

    provider.dispose();
  });

  test("channel: forge → promote to promoted → ComponentProvider loads it", async () => {
    const store = createInMemoryForgeStore();
    const executor = mockExecutor();
    const context: ForgeContext = {
      agentId: "agent-int",
      depth: 0,
      sessionId: "session-int",
      forgesThisSession: 0,
    };
    const config = createDefaultForgeConfig();
    const deps: ForgeDeps = { store, executor, verifiers: [], config, context };

    // Step 1: Forge channel
    const forgeCh = createForgeChannelTool(deps);
    const forgeResult = (await forgeCh.execute({
      name: "slackChannel",
      description: "Slack I/O adapter",
      implementation: "return { send: async () => {}, onMessage: () => () => {} };",
    })) as { readonly ok: true; readonly value: ForgeResult };

    expect(forgeResult.ok).toBe(true);
    expect(forgeResult.value.kind).toBe("channel");

    // Step 2: Promote to "promoted"
    const promoteTool = createPromoteForgeTool(deps);
    const promoteResult = (await promoteTool.execute({
      brickId: forgeResult.value.id,
      targetTrustTier: "promoted",
    })) as { readonly ok: true; readonly value: PromoteResult };

    expect(promoteResult.ok).toBe(true);
    expect(promoteResult.value.applied).toBe(true);

    // Step 3: ComponentProvider loads the promoted channel
    const provider = createForgeComponentProvider({ store, executor });
    const components = extractMap(await provider.attach(stubAgent()));

    const tok = channelToken("slackChannel") as string;
    expect(components.has(tok)).toBe(true);

    const brick = components.get(tok) as ImplementationArtifact;
    expect(brick.kind).toBe("channel");

    provider.dispose();
  });

  test("trust enforcement: middleware at 'verified' is skipped by ComponentProvider", async () => {
    const store = createInMemoryForgeStore();
    const executor = mockExecutor();
    const context: ForgeContext = {
      agentId: "agent-int",
      depth: 0,
      sessionId: "session-int",
      forgesThisSession: 0,
    };
    const config = createDefaultForgeConfig();
    const deps: ForgeDeps = { store, executor, verifiers: [], config, context };

    // Forge middleware (starts at "sandbox")
    const forgeMw = createForgeMiddlewareTool(deps);
    const forgeResult = (await forgeMw.execute({
      name: "untrustedMw",
      description: "Middleware without promoted trust",
      implementation: "return {};",
    })) as { readonly ok: true; readonly value: ForgeResult };

    expect(forgeResult.ok).toBe(true);

    // Promote to "verified" (not enough for middleware — needs "promoted")
    const promoteTool = createPromoteForgeTool(deps);
    await promoteTool.execute({
      brickId: forgeResult.value.id,
      targetTrustTier: "verified",
    });

    // ComponentProvider should skip this middleware
    const provider = createForgeComponentProvider({ store, executor });
    const components = extractMap(await provider.attach(stubAgent()));

    const tok = middlewareToken("untrustedMw") as string;
    expect(components.has(tok)).toBe(false);

    provider.dispose();
  });

  test("trust enforcement after promotion: promoted middleware is loaded", async () => {
    const store = createInMemoryForgeStore();
    const executor = mockExecutor();
    const context: ForgeContext = {
      agentId: "agent-int",
      depth: 0,
      sessionId: "session-int",
      forgesThisSession: 0,
    };
    const config = createDefaultForgeConfig();
    const deps: ForgeDeps = { store, executor, verifiers: [], config, context };

    // Forge middleware (starts at "sandbox")
    const forgeMw = createForgeMiddlewareTool(deps);
    const forgeResult = (await forgeMw.execute({
      name: "trustedMw",
      description: "Middleware that will be promoted",
      implementation: "return { afterModel: async (ctx) => ctx };",
    })) as { readonly ok: true; readonly value: ForgeResult };

    // First: verify middleware at sandbox trust is NOT loaded
    const provider1 = createForgeComponentProvider({ store, executor });
    const components1 = extractMap(await provider1.attach(stubAgent()));
    expect(components1.has(middlewareToken("trustedMw") as string)).toBe(false);
    provider1.dispose();

    // Now promote to "promoted"
    const promoteTool = createPromoteForgeTool(deps);
    await promoteTool.execute({
      brickId: forgeResult.value.id,
      targetTrustTier: "promoted",
    });

    // After promotion: ComponentProvider loads it
    const provider2 = createForgeComponentProvider({ store, executor });
    const components2 = extractMap(await provider2.attach(stubAgent()));
    expect(components2.has(middlewareToken("trustedMw") as string)).toBe(true);
    provider2.dispose();
  });

  test("zone-scoped middleware only visible to matching zone", async () => {
    const store = createInMemoryForgeStore();
    const executor = mockExecutor();
    const context: ForgeContext = {
      agentId: "agent-int",
      depth: 0,
      sessionId: "session-int",
      forgesThisSession: 0,
    };
    const config = createDefaultForgeConfig({ defaultScope: "zone" });
    const deps: ForgeDeps = { store, executor, verifiers: [], config, context };

    // Forge middleware with zone scope + zone tag
    const forgeMw = createForgeMiddlewareTool(deps);
    const forgeResult = (await forgeMw.execute({
      name: "zonedMiddleware",
      description: "Zone-scoped middleware",
      implementation: "return {};",
      tags: ["zone:team-alpha"],
    })) as { readonly ok: true; readonly value: ForgeResult };

    expect(forgeResult.ok).toBe(true);

    // Promote to "promoted"
    const promoteTool = createPromoteForgeTool(deps);
    await promoteTool.execute({
      brickId: forgeResult.value.id,
      targetTrustTier: "promoted",
    });

    // ComponentProvider with matching zone sees it
    const providerMatch = createForgeComponentProvider({
      store,
      executor,
      zoneId: "team-alpha",
    });
    const componentsMatch = extractMap(await providerMatch.attach(stubAgent()));
    expect(componentsMatch.has(middlewareToken("zonedMiddleware") as string)).toBe(true);
    providerMatch.dispose();

    // ComponentProvider with different zone does NOT see it
    const providerOther = createForgeComponentProvider({
      store,
      executor,
      zoneId: "team-beta",
    });
    const componentsOther = extractMap(await providerOther.attach(stubAgent()));
    expect(componentsOther.has(middlewareToken("zonedMiddleware") as string)).toBe(false);
    providerOther.dispose();
  });

  test("requires enforcement: brick with missing env is skipped by ComponentProvider", async () => {
    const store = createInMemoryForgeStore();
    const executor = mockExecutor();
    const context: ForgeContext = {
      agentId: "agent-int",
      depth: 0,
      sessionId: "session-int",
      forgesThisSession: 0,
    };
    const config = createDefaultForgeConfig();
    const deps: ForgeDeps = { store, executor, verifiers: [], config, context };

    // Forge middleware with an env requirement that won't be satisfied
    const forgeMw = createForgeMiddlewareTool(deps);
    const forgeResult = (await forgeMw.execute({
      name: "requiresMiddleware",
      description: "Middleware with unsatisfied env requirement",
      implementation: "return {};",
      requires: { env: ["__KOI_NONEXISTENT_ENV_VAR_XYZ__"] },
    })) as { readonly ok: true; readonly value: ForgeResult };

    expect(forgeResult.ok).toBe(true);

    // Promote to "promoted" (sufficient trust for middleware)
    const promoteTool = createPromoteForgeTool(deps);
    await promoteTool.execute({
      brickId: forgeResult.value.id,
      targetTrustTier: "promoted",
    });

    // ComponentProvider should skip this brick due to unsatisfied requires
    const provider = createForgeComponentProvider({ store, executor });
    const components = extractMap(await provider.attach(stubAgent()));

    const tok = middlewareToken("requiresMiddleware") as string;
    expect(components.has(tok)).toBe(false);

    provider.dispose();
  });

  test("config schema: forged middleware with configSchema is stored and retrievable", async () => {
    const store = createInMemoryForgeStore();
    const executor = mockExecutor();
    const context: ForgeContext = {
      agentId: "agent-int",
      depth: 0,
      sessionId: "session-int",
      forgesThisSession: 0,
    };
    const config = createDefaultForgeConfig();
    const deps: ForgeDeps = { store, executor, verifiers: [], config, context };

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
    const loadResult = await store.load(forgeResult.value.id);
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
