/**
 * Progressive command allowlisting middleware factory.
 */

import type { JsonObject } from "@koi/core/common";
import type {
  KoiMiddleware,
  SessionContext,
  ToolHandler,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core/middleware";
import type { RiskAnalysis, SecurityAnalyzer } from "@koi/core/security-analyzer";
import { RISK_ANALYSIS_UNKNOWN } from "@koi/core/security-analyzer";
import { KoiRuntimeError } from "@koi/errors";
import { DEFAULT_APPROVAL_TIMEOUT_MS, type ExecApprovalsConfig } from "./config.js";
import {
  defaultExtractCommand,
  findFirstAskMatch,
  matchesAnyCompound,
  normalizePattern,
} from "./pattern.js";
import { createInMemoryRulesStore } from "./store.js";
import type {
  ExecApprovalRequest,
  ExecRulesStore,
  PersistedRules,
  ProgressiveDecision,
} from "./types.js";

const DEFAULT_ANALYZER_TIMEOUT_MS = 2_000;

/**
 * Per-session mutable state: accumulated allow/deny patterns beyond the base config.
 * Entries added by allow_session, allow_always, deny_always decisions.
 */
interface SessionRulesState {
  // let-justified: accumulated during session, grows with progressive decisions
  extraAllow: string[];
  extraDeny: string[];
}

export function createExecApprovalsMiddleware(rawConfig: ExecApprovalsConfig): KoiMiddleware {
  const {
    rules,
    onAsk,
    store: storeOption,
    approvalTimeoutMs = DEFAULT_APPROVAL_TIMEOUT_MS,
    onSaveError,
    onLoadError,
    extractCommand = defaultExtractCommand,
    securityAnalyzer,
    analyzerTimeoutMs = DEFAULT_ANALYZER_TIMEOUT_MS,
  } = rawConfig;

  // Resolve store — default to in-memory
  const store: ExecRulesStore = storeOption ?? createInMemoryRulesStore();

  // Normalize all base patterns once at construction time
  const baseAllow = rules.allow.map(normalizePattern);
  const baseDeny = rules.deny.map(normalizePattern);
  const baseAsk = rules.ask.map(normalizePattern);

  // Session state keyed by sessionId
  const sessions = new Map<string, SessionRulesState>();

  async function persistRules(state: SessionRulesState): Promise<void> {
    const loaded = await store.load();
    // Merge: combine loaded + session extra, deduplicate
    const mergedAllow = dedupe([...loaded.allow, ...state.extraAllow]);
    const mergedDeny = dedupe([...loaded.deny, ...state.extraDeny]);
    await store.save({ allow: mergedAllow, deny: mergedDeny });
  }

  return {
    name: "exec-approvals",
    describeCapabilities: () => ({
      label: "exec-approvals",
      description: "Tool execution requires approval before proceeding",
    }),
    priority: 100,

    async onSessionStart(ctx: SessionContext): Promise<void> {
      // Load persisted rules — on failure, start with empty state (less permissive)
      let loaded: PersistedRules = { allow: [], deny: [] };
      try {
        loaded = await store.load();
      } catch (e: unknown) {
        onLoadError?.(e);
      }

      sessions.set(ctx.sessionId, {
        extraAllow: loaded.allow.map(normalizePattern),
        extraDeny: loaded.deny.map(normalizePattern),
      });
    },

    async onSessionEnd(ctx: SessionContext): Promise<void> {
      sessions.delete(ctx.sessionId);
    },

    async wrapToolCall(
      ctx: TurnContext,
      request: ToolRequest,
      next: ToolHandler,
    ): Promise<ToolResponse> {
      const { toolId, input } = request;
      const state = sessions.get(ctx.session.sessionId);

      // -----------------------------------------------------------------------
      // Evaluation order (security invariant):
      // 1. base deny    → ABSOLUTE, cannot be overridden by any session approval
      // 2. session deny → accumulated deny_always decisions
      // 3. session allow → accumulated allow_session / allow_always decisions
      // 4. base allow   → static allow list
      // 5. base ask     → trigger onAsk, handle ProgressiveDecision
      // 6. default deny → no rule matched
      // -----------------------------------------------------------------------

      // 1. Base deny — absolute
      if (matchesAnyCompound(baseDeny, toolId, input, extractCommand)) {
        throw KoiRuntimeError.from("PERMISSION", `Tool "${toolId}" is denied by policy`, {
          context: { toolId },
        });
      }

      // 2. Session deny (accumulated deny_always)
      if (
        state !== undefined &&
        matchesAnyCompound(state.extraDeny, toolId, input, extractCommand)
      ) {
        throw KoiRuntimeError.from("PERMISSION", `Tool "${toolId}" is denied by session policy`, {
          context: { toolId },
        });
      }

      // 3. Session allow (accumulated allow_session / allow_always)
      if (
        state !== undefined &&
        matchesAnyCompound(state.extraAllow, toolId, input, extractCommand)
      ) {
        return next(request);
      }

      // 4. Base allow
      if (matchesAnyCompound(baseAllow, toolId, input, extractCommand)) {
        return next(request);
      }

      // 5. Base ask
      const matchedPattern = findFirstAskMatch(baseAsk, toolId, input, extractCommand);
      if (matchedPattern !== undefined) {
        // Run risk analysis if a SecurityAnalyzer is configured (fail-open).
        // Analyzer fires only on the ask-tier — zero overhead for allow/deny paths.
        let riskAnalysis: RiskAnalysis | undefined;
        if (securityAnalyzer !== undefined) {
          const analyzerCtx: JsonObject = { sessionId: ctx.session.sessionId };
          riskAnalysis = await runAnalyzer(
            securityAnalyzer,
            toolId,
            input,
            analyzerCtx,
            analyzerTimeoutMs,
          );
        }

        // Auto-deny critical risk without prompting the user
        if (riskAnalysis?.riskLevel === "critical") {
          throw KoiRuntimeError.from(
            "PERMISSION",
            `Tool "${toolId}" auto-denied: critical risk — ${riskAnalysis.rationale}`,
            { context: { toolId, riskLevel: "critical" } },
          );
        }

        const askRequest: ExecApprovalRequest =
          riskAnalysis !== undefined
            ? { toolId, input, matchedPattern, riskAnalysis }
            : { toolId, input, matchedPattern };

        const decision = await askWithTimeout(onAsk, askRequest, approvalTimeoutMs);

        switch (decision.kind) {
          case "allow_once": {
            return next(request);
          }

          case "allow_session": {
            if (state !== undefined) {
              state.extraAllow.push(normalizePattern(decision.pattern));
            }
            return next(request);
          }

          case "allow_always": {
            if (state !== undefined) {
              state.extraAllow.push(normalizePattern(decision.pattern));
            }
            try {
              if (state !== undefined) {
                await persistRules(state);
              }
            } catch (e: unknown) {
              onSaveError?.(e);
            }
            return next(request);
          }

          case "deny_once": {
            throw KoiRuntimeError.from("PERMISSION", decision.reason, {
              context: { toolId },
            });
          }

          case "deny_always": {
            if (state !== undefined) {
              state.extraDeny.push(normalizePattern(decision.pattern));
            }
            try {
              if (state !== undefined) {
                await persistRules(state);
              }
            } catch (e: unknown) {
              onSaveError?.(e);
            }
            throw KoiRuntimeError.from("PERMISSION", decision.reason, {
              context: { toolId },
            });
          }

          default: {
            // Exhaustive check
            const _exhaustive: never = decision;
            throw new Error(
              `Unhandled decision kind: ${String((_exhaustive as { kind: string }).kind)}`,
            );
          }
        }
      }

      // 6. Default deny
      throw KoiRuntimeError.from(
        "PERMISSION",
        `Tool "${toolId}" is not in the allow list (default deny)`,
        { context: { toolId } },
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run the SecurityAnalyzer with a timeout. Fail-open: any error or timeout
 * returns RISK_ANALYSIS_UNKNOWN so the ask flow continues normally.
 */
async function runAnalyzer(
  analyzer: SecurityAnalyzer,
  toolId: string,
  input: JsonObject,
  context: JsonObject,
  timeoutMs: number,
): Promise<RiskAnalysis> {
  try {
    return await Promise.race([
      Promise.resolve(analyzer.analyze(toolId, input, context)),
      new Promise<RiskAnalysis>((resolve) => {
        const timer = setTimeout(() => resolve(RISK_ANALYSIS_UNKNOWN), timeoutMs);
        if (typeof timer === "object" && "unref" in timer) {
          (timer as { unref(): void }).unref();
        }
      }),
    ]);
  } catch {
    return RISK_ANALYSIS_UNKNOWN;
  }
}

async function askWithTimeout(
  onAsk: (req: ExecApprovalRequest) => Promise<ProgressiveDecision>,
  req: ExecApprovalRequest,
  timeoutMs: number,
): Promise<ProgressiveDecision> {
  const ac = new AbortController();
  return Promise.race([
    onAsk(req),
    new Promise<never>((_, reject) => {
      const timerId = setTimeout(() => {
        reject(
          KoiRuntimeError.from(
            "TIMEOUT",
            `Approval timed out after ${timeoutMs}ms for tool "${req.toolId}"`,
            {
              context: { toolId: req.toolId, timeoutMs },
            },
          ),
        );
      }, timeoutMs);
      ac.signal.addEventListener("abort", () => clearTimeout(timerId), { once: true });
    }),
  ]).finally(() => {
    ac.abort();
  });
}

function dedupe(arr: readonly string[]): string[] {
  return [...new Set(arr)];
}
