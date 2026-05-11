import type { ZoneEvaluator, ZoneVerdict } from "@koi/approval-zones";
import type { PermissionQuery, SandboxProfile } from "@koi/core";
import type { SandboxRouter } from "@koi/sandbox-router";

/**
 * Read-only preview profile for `sandbox-then-auto`.
 *
 * Deny-by-default: filesystem reads closed, network disabled, hard
 * timeout + memory cap. The preview is a *rehearsal* — the host re-run
 * is what actually has side effects. This profile codifies the safety
 * intent documented in #1644 ("sandboxed execution provides damage
 * containment"); without an explicit profile the router would apply
 * adapter defaults that may grant broad network / fs access and
 * undermine the rehearsal value.
 */
const PREVIEW_PROFILE: SandboxProfile = {
  filesystem: { defaultReadAccess: "closed" },
  network: { allow: false },
  resources: { timeoutMs: 30_000, maxMemoryMb: 256 },
};

export interface ZoneAuditSink {
  record(
    event:
      | "zone-auto"
      | "zone-sandbox-preview"
      | "zone-sandbox-ok"
      | "zone-sandbox-failed"
      | "zone-ask-passthrough",
    meta: ZoneAuditMeta,
  ): void;
}

export interface ZoneAuditMeta {
  readonly zoneName?: string | undefined;
  readonly riskTier?: string | undefined;
  readonly riskReasons?: readonly string[] | undefined;
  readonly reason?: string | undefined;
  readonly backendId?: string | undefined;
  readonly sandboxExitCode?: number | undefined;
}

export type ZoneOutcome = "auto-allow" | "fall-through";

export interface ApplyZoneVerdictArgs {
  readonly query: PermissionQuery;
  readonly evaluator: ZoneEvaluator;
  readonly sandboxRouter: SandboxRouter | undefined;
  readonly auditSink: ZoneAuditSink;
}

export interface ApplyZoneVerdictResult {
  readonly outcome: ZoneOutcome;
  readonly verdict: ZoneVerdict;
}

function metaFromVerdict(v: ZoneVerdict): ZoneAuditMeta {
  if (v.kind === "ask") {
    return { zoneName: v.zone, riskTier: v.risk, riskReasons: v.riskReasons, reason: v.reason };
  }
  if (v.kind === "auto") {
    return { zoneName: v.zone, riskTier: v.risk, riskReasons: v.riskReasons };
  }
  return {
    zoneName: v.zone,
    riskTier: v.risk,
    riskReasons: v.riskReasons,
    backendId: v.backendId,
  };
}

export async function applyZoneVerdict(
  args: ApplyZoneVerdictArgs,
): Promise<ApplyZoneVerdictResult> {
  const verdict = await args.evaluator.evaluate(args.query);

  if (verdict.kind === "ask") {
    if (verdict.zone !== undefined) {
      // Zone matched but bailed (risk-exceeded / non-bash-tool / missing-backend / *-error).
      args.auditSink.record("zone-ask-passthrough", metaFromVerdict(verdict));
    }
    return { outcome: "fall-through", verdict };
  }

  if (verdict.kind === "auto") {
    args.auditSink.record("zone-auto", metaFromVerdict(verdict));
    return { outcome: "auto-allow", verdict };
  }

  // sandbox
  if (args.sandboxRouter === undefined) {
    args.auditSink.record("zone-sandbox-failed", {
      ...metaFromVerdict(verdict),
      reason: "no-router-configured",
    });
    return { outcome: "fall-through", verdict };
  }

  args.auditSink.record("zone-sandbox-preview", metaFromVerdict(verdict));

  const command =
    typeof args.query.context?.command === "string" ? (args.query.context.command as string) : "";
  if (command === "") {
    args.auditSink.record("zone-sandbox-failed", {
      ...metaFromVerdict(verdict),
      reason: "missing-command",
    });
    return { outcome: "fall-through", verdict };
  }

  try {
    const created = await args.sandboxRouter.create(PREVIEW_PROFILE);
    if (!created.ok) {
      args.auditSink.record("zone-sandbox-failed", {
        ...metaFromVerdict(verdict),
        reason: created.error.message,
      });
      return { outcome: "fall-through", verdict };
    }
    const { instance, decision } = created.value;
    // Fail closed if the router didn't select the backend the zone policy
    // pinned. Without this, a stricter backend could be silently substituted
    // by an unrelated default adapter, weakening the policy intent.
    const selectedName = decision?.selected?.name;
    if (selectedName !== verdict.backendId) {
      args.auditSink.record("zone-sandbox-failed", {
        ...metaFromVerdict(verdict),
        reason: `backend-mismatch:selected=${selectedName ?? "unknown"}`,
      });
      try {
        await instance.destroy();
      } catch {
        // destroy errors during teardown are non-fatal
      }
      return { outcome: "fall-through", verdict };
    }
    try {
      const result = await instance.exec("bash", ["-lc", command], { timeoutMs: 30_000 });
      if (result.exitCode === 0) {
        args.auditSink.record("zone-sandbox-ok", {
          ...metaFromVerdict(verdict),
          sandboxExitCode: result.exitCode,
        });
        args.auditSink.record("zone-auto", metaFromVerdict(verdict));
        return { outcome: "auto-allow", verdict };
      }
      args.auditSink.record("zone-sandbox-failed", {
        ...metaFromVerdict(verdict),
        sandboxExitCode: result.exitCode,
      });
      return { outcome: "fall-through", verdict };
    } finally {
      try {
        await instance.destroy();
      } catch {
        // destroy errors are not actionable here
      }
    }
  } catch (err) {
    args.auditSink.record("zone-sandbox-failed", {
      ...metaFromVerdict(verdict),
      reason: err instanceof Error ? err.message : String(err),
    });
    return { outcome: "fall-through", verdict };
  }
}
