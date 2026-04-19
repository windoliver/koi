/**
 * GovernanceExtension — KernelExtension that discovers L2-contributed
 * governance variables, seals the builder, and produces the governance
 * guard middleware.
 *
 * Key invariant: uses generic prefix query ("governance:contrib:") to
 * discover contributors — zero L2 knowledge. Any L2 can contribute
 * governance variables by attaching a GovernanceVariableContributor
 * under the "governance:contrib:*" prefix.
 */

import type {
  GovernanceController,
  GovernanceVariableContributor,
  GuardContext,
  KernelExtension,
  KoiMiddleware,
  ModelChunk,
  ModelRequest,
  ModelResponse,
  ModelStreamHandler,
  ToolRequest,
  ToolResponse,
  TurnContext,
  ValidationResult,
} from "@koi/core";
import { EXTENSION_PRIORITY, GOVERNANCE, GOVERNANCE_VARIABLES } from "@koi/core";
import { KoiRuntimeError } from "@koi/errors";
import type { GovernanceControllerBuilder } from "./governance-controller.js";

const DEFAULT_SPAWN_TOOL_IDS: readonly string[] = Object.freeze(["forge_agent", "Spawn"]);

/**
 * Pre-sanitize token counts before calling `controller.record({ kind: "token_usage" })`.
 *
 * Controller-side accounting fails closed by dropping NaN/Infinity/negative
 * values, which silently zeroes spend tracking. Surfacing those values at the
 * engine boundary instead keeps a buggy adapter from poisoning the counters.
 * Returns `undefined` for any non-finite or negative value so callers can drop
 * the field and still record the valid counterpart.
 */
function sanitizeTokenCount(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value < 0) return undefined;
  return value;
}

// ---------------------------------------------------------------------------
// Governance guard middleware
// ---------------------------------------------------------------------------

function createGovernanceGuard(
  controller: GovernanceController,
  spawnToolIds: ReadonlySet<string>,
): KoiMiddleware {
  return {
    name: "koi:governance-guard",
    describeCapabilities: () => undefined,
    priority: 0,

    async onBeforeTurn(_ctx: TurnContext): Promise<void> {
      await controller.record({ kind: "turn" });
      const check = await controller.checkAll();
      if (!check.ok) {
        throw KoiRuntimeError.from(check.retryable ? "RATE_LIMIT" : "TIMEOUT", check.reason, {
          retryable: check.retryable,
          context: { variable: check.variable },
        });
      }
    },

    async wrapToolCall(
      _ctx: TurnContext,
      request: ToolRequest,
      next: (req: ToolRequest) => Promise<ToolResponse>,
    ): Promise<ToolResponse> {
      // Check spawn variables for spawn tools
      if (spawnToolIds.has(request.toolId)) {
        const depthCheck = await controller.check(GOVERNANCE_VARIABLES.SPAWN_DEPTH);
        if (!depthCheck.ok) {
          throw KoiRuntimeError.from("PERMISSION", depthCheck.reason, {
            context: { variable: depthCheck.variable },
          });
        }
        const countCheck = await controller.check(GOVERNANCE_VARIABLES.SPAWN_COUNT);
        if (!countCheck.ok) {
          throw KoiRuntimeError.from("RATE_LIMIT", countCheck.reason, {
            retryable: true,
            context: { variable: countCheck.variable },
          });
        }
      }

      try {
        const response = await next(request);
        // Spawn / spawn_release are recorded directly in spawn-child.ts against
        // the parent's GovernanceController (paired with ledger acquire / release).
        await controller.record({ kind: "tool_success", toolName: request.toolId });
        return response;
      } catch (e: unknown) {
        await controller.record({ kind: "tool_error", toolName: request.toolId });
        throw e;
      }
    },

    async wrapModelCall(
      _ctx: TurnContext,
      request: ModelRequest,
      next: (req: ModelRequest) => Promise<ModelResponse>,
    ): Promise<ModelResponse> {
      const response = await next(request);
      if (response.usage !== undefined) {
        // Drop invalid fields per-side so one bogus value doesn't zero usage
        // tracking on an otherwise valid adapter response.
        const input = sanitizeTokenCount(response.usage.inputTokens);
        const output = sanitizeTokenCount(response.usage.outputTokens);
        const total = (input ?? 0) + (output ?? 0);
        if (total > 0) {
          await controller.record({
            kind: "token_usage",
            count: total,
            ...(input !== undefined ? { inputTokens: input } : {}),
            ...(output !== undefined ? { outputTokens: output } : {}),
          });
        }
      }
      return response;
    },

    async *wrapModelStream(
      _ctx: TurnContext,
      request: ModelRequest,
      next: ModelStreamHandler,
    ): AsyncIterable<ModelChunk> {
      // let justified: mutable accumulators for streamed usage across chunks
      let accInputTokens = 0;
      let accOutputTokens = 0;

      try {
        for await (const chunk of next(request)) {
          if (chunk.kind === "usage") {
            const input = sanitizeTokenCount(chunk.inputTokens);
            const output = sanitizeTokenCount(chunk.outputTokens);
            if (input !== undefined) accInputTokens += input;
            if (output !== undefined) accOutputTokens += output;
          } else if (chunk.kind === "done" && chunk.response.usage !== undefined) {
            // "done" carries the authoritative final usage — prefer it over
            // incremental accumulation. Reset only when both fields are valid
            // so a bogus authoritative reading can't clobber good incrementals.
            const input = sanitizeTokenCount(chunk.response.usage.inputTokens);
            const output = sanitizeTokenCount(chunk.response.usage.outputTokens);
            if (input !== undefined && output !== undefined) {
              accInputTokens = input;
              accOutputTokens = output;
            }
          }
          yield chunk;
        }
      } finally {
        // Record accumulated usage regardless of how the stream exits (normal
        // completion, throw, or abort). Without this, an errored/aborted stream
        // would silently drop all accumulated token accounting.
        const total = accInputTokens + accOutputTokens;
        if (total > 0) {
          await controller.record({
            kind: "token_usage",
            count: total,
            inputTokens: accInputTokens,
            outputTokens: accOutputTokens,
          });
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------

export function createGovernanceExtension(): KernelExtension {
  return {
    name: "koi:governance",
    priority: EXTENSION_PRIORITY.CORE,

    guards(ctx: GuardContext): readonly KoiMiddleware[] {
      // 1. Read builder from assembled agent
      const builder = ctx.agent?.component<GovernanceControllerBuilder>(
        GOVERNANCE as import("@koi/core").SubsystemToken<GovernanceControllerBuilder>,
      );
      if (builder === undefined || builder.sealed) return [];

      // 2. Discover ALL contributors via prefix query (generic, no L2 knowledge)
      const contributors =
        ctx.agent?.query<GovernanceVariableContributor>("governance:contrib:") ??
        new Map<
          import("@koi/core").SubsystemToken<GovernanceVariableContributor>,
          GovernanceVariableContributor
        >();
      for (const [, contributor] of contributors) {
        for (const variable of contributor.variables()) {
          builder.register(variable);
        }
      }

      // 3. Seal builder — no more registration allowed
      builder.seal();

      // 4. Build spawn tool ID set
      const spawnToolIds = new Set<string>(DEFAULT_SPAWN_TOOL_IDS);

      // 5. Produce governance guard middleware
      return [createGovernanceGuard(builder, spawnToolIds)];
    },

    validateAssembly(
      components: ReadonlyMap<string, unknown>,
      _manifest: import("@koi/core").AgentManifest,
    ): ValidationResult {
      const governance = components.get(GOVERNANCE as string);
      if (governance === undefined) {
        return { ok: true }; // Governance is optional
      }
      // Verify it looks like a GovernanceController (duck typing)
      const ctrl = governance as Record<string, unknown>;
      if (typeof ctrl.check !== "function" || typeof ctrl.checkAll !== "function") {
        return {
          ok: false,
          diagnostics: [
            {
              source: "koi:governance",
              message: "GOVERNANCE component does not implement GovernanceController interface",
              severity: "error",
            },
          ],
        };
      }
      return { ok: true };
    },
  };
}
