/**
 * forge_inspect — primordial LLM-callable tool that reads a single brick by
 * its content-addressed BrickId. The store load is unconditional; the
 * visibility predicate runs on the loaded artifact and collapses peer-private
 * and zone hits to NOT_FOUND so existence is not leaked to the caller.
 */

import type { BrickArtifact, ForgeStore, JsonObject, KoiError, Result, Tool } from "@koi/core";
import { brickId, DEFAULT_SANDBOXED_POLICY } from "@koi/core";
import { toJSONSchema, z } from "zod";
import { formatIssuePath, invalidInput, notFound, resolveCaller } from "../shared.js";

const schema = z.object({
  brickId: z.string().regex(/^sha256:[0-9a-f]{64}$/),
});

export interface ForgeInspectDeps {
  readonly store: ForgeStore;
}

export interface ForgeInspectOk {
  readonly artifact: BrickArtifact;
}

function isVisible(b: BrickArtifact, callerAgentId: string): boolean {
  // Global bricks are publicly readable only when their lifecycle is active.
  // draft / verifying / failed / deprecated / quarantined globals must stay
  // hidden so partially integrated or revoked content is not exposed to
  // every agent in the process.
  if (b.scope === "global") return b.lifecycle === "active";
  if (b.scope === "zone") return false;
  // Agent-scoped bricks are visible only to their owner, regardless of
  // lifecycle (the owner needs to read their own drafts).
  return b.provenance.metadata.agentId === callerAgentId;
}

export function createForgeInspectTool(deps: ForgeInspectDeps): Tool {
  return {
    descriptor: {
      name: "forge_inspect",
      description:
        "Inspect a single forge brick by its content-addressed BrickId. " +
        "Returns NOT_FOUND when the brick is missing or not visible to the caller.",
      inputSchema: toJSONSchema(schema) as JsonObject,
      origin: "primordial",
    },
    origin: "primordial",
    policy: DEFAULT_SANDBOXED_POLICY,
    execute: async (args: JsonObject): Promise<unknown> => {
      const parsed = schema.safeParse(args);
      if (!parsed.success) {
        const failure: Result<ForgeInspectOk, KoiError> = {
          ok: false,
          error: invalidInput("forge_inspect: invalid input", {
            issues: parsed.error.issues.map((i) => `${formatIssuePath(i.path)}: ${i.message}`),
          }),
        };
        return failure;
      }
      // resolveCaller throws NO_CONTEXT when invoked outside an execution context.
      // Resolve BEFORE the load so context errors do not depend on store state.
      const caller = resolveCaller();
      const id = brickId(parsed.data.brickId);
      const loaded = await deps.store.load(id);
      if (!loaded.ok) {
        const failure: Result<ForgeInspectOk, KoiError> = { ok: false, error: loaded.error };
        return failure;
      }
      if (!isVisible(loaded.value, caller.agentId)) {
        const failure: Result<ForgeInspectOk, KoiError> = {
          ok: false,
          error: notFound(id, "Brick not found"),
        };
        return failure;
      }
      const success: Result<ForgeInspectOk, KoiError> = {
        ok: true,
        value: { artifact: loaded.value },
      };
      return success;
    },
  };
}
