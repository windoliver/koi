import type { ZoneEvaluator, ZoneVerdict } from "@koi/approval-zones";
import type { PermissionQuery, SandboxProfile } from "@koi/core";
import type { SandboxRouter } from "@koi/sandbox-router";

/**
 * Path-shaped token regex. Matches absolute or `~/`-prefixed paths in a
 * raw bash command string. Tilde prefixes get expanded later by the host.
 * Intentionally permissive — false positives in extraction widen
 * `allowRead`, which the rest of the policy still constrains.
 */
const PATH_TOKEN_REGEX = /(?<![A-Za-z0-9_])(?:~\/|\/)[A-Za-z0-9_.\-/]+/g;

/** Extract path-shaped tokens from a bash command. Best-effort. */
export function extractBashPathTargets(command: string): readonly string[] {
  if (command === "") return [];
  const out: string[] = [];
  for (const m of command.matchAll(PATH_TOKEN_REGEX)) {
    out.push(m[0]);
  }
  return out;
}

/**
 * Build a deny-by-default preview profile for `sandbox-then-auto`.
 *
 * Filesystem reads start closed; any path tokens extracted from the
 * bash command are added to `allowRead` so commands like `ls /tmp/x`
 * can actually rehearse. Writes are not allow-listed (preview is a
 * read-only rehearsal — the host re-run handles real side effects).
 * Network is disabled; hard timeout + memory cap keep adapter defaults
 * from leaking through.
 */
function buildPreviewProfile(allowRead: readonly string[]): SandboxProfile {
  return {
    filesystem:
      allowRead.length > 0
        ? { defaultReadAccess: "closed", allowRead }
        : { defaultReadAccess: "closed" },
    network: { allow: false },
    resources: { timeoutMs: 30_000, maxMemoryMb: 256 },
  };
}

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

type ZoneSandboxVerdict = Extract<ZoneVerdict, { readonly kind: "sandbox" }>;
type SandboxOk = Extract<Awaited<ReturnType<SandboxRouter["create"]>>, { readonly ok: true }>;
type SandboxCreated = SandboxOk["value"];

async function runSandboxPreview(
  args: ApplyZoneVerdictArgs,
  verdict: ZoneSandboxVerdict,
): Promise<ApplyZoneVerdictResult> {
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
    const created = await args.sandboxRouter.create(
      buildPreviewProfile(extractBashPathTargets(command)),
    );
    if (!created.ok) {
      args.auditSink.record("zone-sandbox-failed", {
        ...metaFromVerdict(verdict),
        reason: created.error.message,
      });
      return { outcome: "fall-through", verdict };
    }
    return await execInSandbox(args, verdict, command, created.value);
  } catch (err) {
    args.auditSink.record("zone-sandbox-failed", {
      ...metaFromVerdict(verdict),
      reason: err instanceof Error ? err.message : String(err),
    });
    return { outcome: "fall-through", verdict };
  }
}

async function execInSandbox(
  args: ApplyZoneVerdictArgs,
  verdict: ZoneSandboxVerdict,
  command: string,
  created: SandboxCreated,
): Promise<ApplyZoneVerdictResult> {
  const { instance, decision } = created;
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
  return runSandboxPreview(args, verdict);
}
