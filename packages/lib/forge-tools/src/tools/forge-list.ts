/**
 * forge_list — primordial LLM-callable tool that returns a bounded list of
 * brick summaries visible to the caller. Visibility is enforced server-side
 * via `ForgeQuery.createdBy` (no full-scan): two queries, one for the caller's
 * agent-scoped bricks and one for globals, each with the caller's `limit`.
 */

import type {
  BrickArtifact,
  BrickSummary,
  ForgeQuery,
  ForgeStore,
  JsonObject,
  KoiError,
  Result,
  Tool,
} from "@koi/core";
import { DEFAULT_SANDBOXED_POLICY, searchSummariesWithFallback } from "@koi/core";
import { sortBricks } from "@koi/validation";
import { toJSONSchema, z } from "zod";
import { invalidInput, resolveCaller } from "../shared.js";

const HARD_CAP = 200;
const DEFAULT_LIMIT = 50;

const schema = z.object({
  kind: z.enum(["tool", "skill", "agent", "middleware", "channel", "composite"]).optional(),
  scope: z.enum(["agent", "zone", "global"]).optional(),
  lifecycle: z
    .enum(["draft", "verifying", "active", "failed", "deprecated", "quarantined"])
    .optional(),
  limit: z.number().int().positive().max(HARD_CAP).optional(),
});

export interface ForgeListDeps {
  readonly store: ForgeStore;
}

export interface ForgeListOk {
  readonly summaries: readonly BrickSummary[];
}

function toSummary(brick: BrickArtifact): BrickSummary {
  return {
    id: brick.id,
    kind: brick.kind,
    name: brick.name,
    description: brick.description,
    tags: brick.tags,
    ...(brick.trigger !== undefined ? { trigger: brick.trigger } : {}),
  };
}

export function createForgeListTool(deps: ForgeListDeps): Tool {
  return {
    descriptor: {
      name: "forge_list",
      description:
        "List forge brick summaries visible to the caller. Filters by kind, scope, lifecycle. " +
        "Returns at most 200 summaries; default 50. Visibility: caller's own agent-scoped bricks plus all globals.",
      inputSchema: toJSONSchema(schema) as JsonObject,
      origin: "primordial",
    },
    origin: "primordial",
    policy: DEFAULT_SANDBOXED_POLICY,
    execute: async (args: JsonObject): Promise<unknown> => {
      const parsed = schema.safeParse(args);
      if (!parsed.success) {
        const failure: Result<ForgeListOk, KoiError> = {
          ok: false,
          error: invalidInput("forge_list: invalid input", {
            issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
          }),
        };
        return failure;
      }
      const input = parsed.data;
      const callerLimit = input.limit ?? DEFAULT_LIMIT;
      // Zone-scoped artifacts are not surfaced in this PR (deferred to scope work).
      if (input.scope === "zone") {
        const empty: Result<ForgeListOk, KoiError> = { ok: true, value: { summaries: [] } };
        return empty;
      }
      // resolveCaller throws NO_CONTEXT when invoked outside an execution context.
      const caller = resolveCaller();

      const wantAgent = input.scope === undefined || input.scope === "agent";
      const wantGlobal = input.scope === undefined || input.scope === "global";

      // Single-scope path: delegate to the store's summary search (which
      // skips the full-artifact deep-clone) since no cross-scope ranking
      // is needed. This avoids materializing heavy implementation/files
      // /schema bytes that would be discarded by the summary projection.
      if (wantAgent !== wantGlobal) {
        const query: ForgeQuery = wantAgent
          ? {
              ...(input.kind !== undefined ? { kind: input.kind } : {}),
              ...(input.lifecycle !== undefined ? { lifecycle: input.lifecycle } : {}),
              scope: "agent",
              createdBy: caller.agentId,
              limit: callerLimit,
            }
          : {
              ...(input.kind !== undefined ? { kind: input.kind } : {}),
              ...(input.lifecycle !== undefined ? { lifecycle: input.lifecycle } : {}),
              scope: "global",
              limit: callerLimit,
            };
        const r = await searchSummariesWithFallback(deps.store, query);
        if (!r.ok) {
          const failure: Result<ForgeListOk, KoiError> = { ok: false, error: r.error };
          return failure;
        }
        const success: Result<ForgeListOk, KoiError> = {
          ok: true,
          value: { summaries: r.value },
        };
        return success;
      }

      // Mixed-scope path: globally rank across both queries using full
      // artifacts (which carry ranking keys like createdAt/fitness). The
      // store deep-clones the per-scope slice, but each slice is bounded
      // by callerLimit so total work is O(callerLimit), not O(total bricks).
      const queries: ForgeQuery[] = [
        {
          ...(input.kind !== undefined ? { kind: input.kind } : {}),
          ...(input.lifecycle !== undefined ? { lifecycle: input.lifecycle } : {}),
          scope: "agent",
          createdBy: caller.agentId,
          limit: callerLimit,
        },
        {
          ...(input.kind !== undefined ? { kind: input.kind } : {}),
          ...(input.lifecycle !== undefined ? { lifecycle: input.lifecycle } : {}),
          scope: "global",
          limit: callerLimit,
        },
      ];
      const responses = await Promise.all(queries.map((q) => deps.store.search(q)));
      for (const r of responses) {
        if (!r.ok) {
          const failure: Result<ForgeListOk, KoiError> = { ok: false, error: r.error };
          return failure;
        }
      }
      const merged: readonly BrickArtifact[] = responses.flatMap((r) => (r.ok ? r.value : []));
      const mergeQuery: ForgeQuery = {
        ...(input.kind !== undefined ? { kind: input.kind } : {}),
        ...(input.lifecycle !== undefined ? { lifecycle: input.lifecycle } : {}),
        limit: callerLimit,
      };
      const ranked = sortBricks(merged, mergeQuery, { nowMs: Date.now() });
      const sliced = ranked.slice(0, callerLimit).map(toSummary);
      const success: Result<ForgeListOk, KoiError> = { ok: true, value: { summaries: sliced } };
      return success;
    },
  };
}
