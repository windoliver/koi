import type { JsonObject, Tool } from "@koi/core";
import { DEFAULT_SANDBOXED_POLICY } from "@koi/core";

import { toJSONSchema, z } from "zod";
import { spawnCacheKey } from "../spawn-result-cache.js";
import type { SpawnToolsConfig } from "../types.js";

const schema = z.object({
  agent_name: z
    .string()
    .min(1)
    .describe(
      "Name of the agent definition to spawn (e.g. 'researcher', 'coder', 'reviewer'). " +
        "Must match a built-in or project-defined agent.",
    ),
  description: z
    .string()
    .min(1)
    .describe("Clear description of the work this child agent should perform."),
  context: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Optional structured context passed to the child agent as additional input."),
});

/**
 * Round-trip the context through JSON to produce a canonical payload that is
 * shared by the description block, the cache digest, and the forwarded
 * `spawnFn` request. This guarantees that what we hash is exactly what the
 * child sees:
 *   - `Date` → ISO string (matches `JSON.stringify` behavior)
 *   - `BigInt`, cyclic refs, etc. → throws → fail closed with a clean error
 *   - Plain JSON values pass through unchanged
 */
function normalizeContext(
  context: unknown,
):
  | { readonly ok: true; readonly value: JsonObject | undefined }
  | { readonly ok: false; readonly error: string } {
  if (context === undefined) return { ok: true, value: undefined };
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(context);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `context is not JSON-serializable: ${message}` };
  }
  if (serialized === undefined) {
    return { ok: false, error: "context is not JSON-serializable" };
  }
  return { ok: true, value: JSON.parse(serialized) as JsonObject };
}

/**
 * Recursively sort object keys so that two contexts with identical data but
 * different insertion order produce the same byte representation. The same
 * canonical form feeds both the child's prompt and the cache digest, so the
 * cache cannot collapse two calls whose prompt text would otherwise differ.
 */
function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const obj = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(obj).sort()) {
    sorted[k] = canonicalize(obj[k]);
  }
  return sorted;
}

function descriptionWithContext(description: string, context: JsonObject | undefined): string {
  if (context === undefined) return description;
  // Context is already round-tripped through JSON in normalizeContext, so
  // this serialization never throws. Canonicalize keys so the child sees
  // the same prompt regardless of insertion order — and the cache key
  // (which hashes the same canonical form) stays in lockstep with what
  // the child actually receives.
  const serialized = JSON.stringify(canonicalize(context), null, 2);
  return `${description}\n\nStructured context:\n${serialized}`;
}

/**
 * agent_spawn — LLM-callable tool for coordinator agents.
 *
 * Spawns a named child agent to complete a specific task. The child runs
 * asynchronously and returns its final output string.
 *
 * Design: agent_spawn and task_delegate are intentionally independent.
 * For simple use, the coordinator calls agent_spawn directly (like CC's Agent
 * tool). For autonomous/swarm use (#1553), a bridge component (like v1's
 * dispatchSpawnTasks) couples them: task_delegate → agent_spawn → auto-complete.
 * The bridge is a separate layer, not baked into these tools.
 */
export function createAgentSpawnTool(config: SpawnToolsConfig): Tool {
  return {
    descriptor: {
      name: "agent_spawn",
      description:
        "Spawn a named child agent to complete a task. " +
        "Returns the child agent's final output as a string.",
      inputSchema: toJSONSchema(schema) as JsonObject,
      origin: "primordial",
    },
    origin: "primordial",
    policy: DEFAULT_SANDBOXED_POLICY,
    execute: async (args: JsonObject): Promise<unknown> => {
      const parsed = schema.safeParse(args);
      if (!parsed.success) {
        return { ok: false, error: parsed.error.message };
      }

      const { agent_name, description, context: rawContext } = parsed.data;

      const normalized = normalizeContext(rawContext);
      if (!normalized.ok) {
        return { ok: false, error: normalized.error };
      }
      const context = normalized.value;
      const childDescription = descriptionWithContext(description, context);

      const invokeSpawn = async (): Promise<
        | { readonly ok: true; readonly output: string; readonly cacheable?: boolean }
        | { readonly ok: false; readonly error: string }
      > => {
        const result = await config.spawnFn({
          agentName: agent_name,
          description: childDescription,
          ...(context !== undefined ? { context } : {}),
          signal: config.signal,
          agentId: config.agentId,
        });
        if (!result.ok) return { ok: false, error: result.error.message };
        // Propagate cacheability from the engine. Non-streaming delivery
        // implementations return `cacheable: false` so we don't cache a
        // placeholder admission as if it were a completed result.
        return result.cacheable === false
          ? { ok: true, output: result.output, cacheable: false }
          : { ok: true, output: result.output };
      };

      const cacheKey =
        config.resultCache !== undefined
          ? spawnCacheKey(config.agentId, agent_name, description, context)
          : undefined;

      if (cacheKey === undefined || config.resultCache === undefined) {
        const direct = await invokeSpawn();
        return direct.ok ? { ok: true, output: direct.output } : { ok: false, error: direct.error };
      }

      const run = await config.resultCache.runDeduped(cacheKey, config.signal, invokeSpawn);
      if (!run.ok) return { ok: false, error: run.error };
      return run.deduplicated
        ? { ok: true, output: run.output, deduplicated: true }
        : { ok: true, output: run.output };
    },
  };
}
