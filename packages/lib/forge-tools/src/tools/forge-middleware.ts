/**
 * forge_middleware — primordial LLM-callable tool that synthesizes an
 * `ImplementationArtifact` (kind: "middleware") and persists it via the
 * injected `ForgeStore`. Resolves the caller from the active execution
 * context at execute time and stamps a minimal `ForgeProvenance` block with
 * `origin: "forged"`. Middleware bricks are non-sandboxed per
 * `SANDBOX_REQUIRED_BY_KIND` (middleware/channel must be sandbox: false).
 */

import type {
  ForgeProvenance,
  ForgeStore,
  ImplementationArtifact,
  JsonObject,
  KoiError,
  Result,
  Tool,
} from "@koi/core";
import { DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import { getExecutionContext } from "@koi/execution-context";
import { toJSONSchema, z } from "zod";
import { computeIdentityBrickId, forbidden, invalidInput, resolveCaller } from "../shared.js";

const FORGE_BUILDER_ID = "@koi/forge-tools" as const;
const FORGE_BUILD_TYPE = "https://koi.dev/forge-tools/v1" as const;

const schema = z.object({
  name: z.string().min(1).describe("Unique middleware name within scope."),
  description: z.string().min(1).describe("What the middleware does."),
  version: z.string().min(1).describe("Semantic version, e.g. '0.0.1'."),
  scope: z.enum(["agent", "zone", "global"]).describe("Visibility scope."),
  implementation: z
    .string()
    .min(1)
    .describe("Middleware body. Function-body string evaluated by the runner."),
});

export interface ForgeMiddlewareDeps {
  readonly store: ForgeStore;
}

export interface ForgeMiddlewareOk {
  readonly brickId: string;
  readonly lifecycle: "draft";
}

function buildProvenance(
  agentId: string,
  sessionIdValue: string,
  contentHash: string,
  startedAt: number,
): ForgeProvenance {
  const now = Date.now();
  return {
    source: { origin: "forged", forgedBy: agentId, sessionId: sessionIdValue },
    buildDefinition: {
      buildType: FORGE_BUILD_TYPE,
      externalParameters: {},
    },
    builder: { id: FORGE_BUILDER_ID },
    metadata: {
      invocationId: contentHash,
      startedAt,
      finishedAt: now,
      sessionId: sessionIdValue,
      agentId,
      depth: 0,
    },
    verification: {
      passed: false,
      sandbox: false,
      totalDurationMs: 0,
      stageResults: [],
    },
    classification: "internal",
    contentMarkers: [],
    contentHash,
  };
}

export function createForgeMiddlewareTool(deps: ForgeMiddlewareDeps): Tool {
  return {
    descriptor: {
      name: "forge_middleware",
      description:
        "Synthesize a new middleware brick (kind: 'middleware') and persist it as a draft. " +
        "Returns the brickId. Middleware defaults to scope: 'agent' (private to caller). " +
        "Middleware is non-sandboxed by contract (it wraps the engine adapter). " +
        "Scope 'zone' is not yet supported; scope 'global' requires a capability " +
        "not yet plumbed.",
      inputSchema: toJSONSchema(schema) as JsonObject,
      origin: "primordial",
    },
    origin: "primordial",
    policy: DEFAULT_UNSANDBOXED_POLICY,
    execute: async (args: JsonObject): Promise<unknown> => {
      const startedAt = Date.now();
      const parsed = schema.safeParse(args);
      if (!parsed.success) {
        const failure: Result<ForgeMiddlewareOk, KoiError> = {
          ok: false,
          error: invalidInput("forge_middleware: invalid input", {
            issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
          }),
        };
        return failure;
      }
      const input = parsed.data;
      if (input.scope === "zone") {
        const failure: Result<ForgeMiddlewareOk, KoiError> = {
          ok: false,
          error: invalidInput(
            "forge_middleware: scope 'zone' unsupported in primordial forge-tools",
          ),
        };
        return failure;
      }
      if (input.scope === "global") {
        const failure: Result<ForgeMiddlewareOk, KoiError> = {
          ok: false,
          error: forbidden(
            "forge_middleware: scope 'global' synthesis requires capability not yet available",
          ),
        };
        return failure;
      }
      // resolveCaller throws NO_CONTEXT when invoked outside an execution context.
      const caller = resolveCaller();
      const ctx = getExecutionContext();
      if (ctx === undefined) {
        // Defensive: resolveCaller already throws, but narrows the type for ctx.
        throw new Error("NO_CONTEXT: forge_middleware invoked outside execution context");
      }
      const content: JsonObject = {
        implementation: input.implementation,
      };
      const id = computeIdentityBrickId({
        kind: "middleware",
        name: input.name,
        description: input.description,
        version: input.version,
        scope: input.scope,
        ownerAgentId: caller.agentId,
        content,
      });
      const provenance = buildProvenance(caller.agentId, ctx.session.sessionId, id, startedAt);
      const artifact: ImplementationArtifact = {
        id,
        kind: "middleware",
        name: input.name,
        description: input.description,
        scope: input.scope,
        origin: "forged",
        policy: DEFAULT_UNSANDBOXED_POLICY,
        lifecycle: "draft",
        provenance,
        version: input.version,
        tags: [],
        usageCount: 0,
        implementation: input.implementation,
      };
      const saved = await deps.store.save(artifact);
      if (!saved.ok) {
        const failure: Result<ForgeMiddlewareOk, KoiError> = { ok: false, error: saved.error };
        return failure;
      }
      const success: Result<ForgeMiddlewareOk, KoiError> = {
        ok: true,
        value: { brickId: id, lifecycle: "draft" },
      };
      return success;
    },
  };
}
