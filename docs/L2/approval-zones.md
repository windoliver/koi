# @koi/approval-zones — Approval Zones with Sandboxed Execution

Pre-ask interceptor that converts `ask` verdicts from the rule evaluator into automatic approvals or sandboxed-preview executions, based on configured zones and a pluggable risk scorer. Zones never override `allow` or `deny`; they only intercept `ask`.

---

## Configuration

```typescript
import {
  createDefaultRiskScorer,
  createZoneEvaluator,
  READ_ONLY_PROFILE,
} from "@koi/approval-zones";
import { createPermissionsMiddleware } from "@koi/middleware-permissions";
import { createSandboxRouter } from "@koi/sandbox/sandbox-router";

// One concrete zone plus the built-in read-only bundle
const zones = [
  ...READ_ONLY_PROFILE,
  {
    name: "cleanup-tmp",
    match: { tools: ["bash"], paths: ["/tmp/**"] },
    action: "sandbox-then-auto",
    maxRisk: "medium",
    sandboxBackendId: "docker-default",
  },
] as const;

const scorer = createDefaultRiskScorer({ projectRoot: "/Users/you/project" });
const evaluator = createZoneEvaluator({ zones, scorer });

const mw = createPermissionsMiddleware({
  backend: myPermissionBackend,
  zones: {
    evaluator,
    sandboxRouter: createSandboxRouter(), // required when any zone uses "sandbox-then-auto"
  },
});
```

Omitting the `zones` key leaves existing behavior fully unchanged.

---

## Zone Schema Reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | yes | Human-readable identifier. Appears in audit events. |
| `match.tools` | `readonly string[]` | no | Glob patterns matched against `toolId`. Omit to match all tools. |
| `match.paths` | `readonly string[]` | no | Glob patterns matched against the query resource path. |
| `match.args` | `Record<string, string>` | no | Per-key glob predicates matched against query context args. |
| `action` | `"auto" \| "ask" \| "sandbox-then-auto"` | yes | What to do when zone matches and risk is within `maxRisk`. |
| `maxRisk` | `RiskTier` | no | Ceiling tier; defaults to `"low"`. The action only fires when scored risk is at or below this tier. |
| `sandboxBackendId` | `string` | conditional | Required when `action === "sandbox-then-auto"`. Identifies the sandbox backend to resolve via `sandbox-router`. |

**Note on `sandbox-then-auto`:** In v1, this action is restricted to `toolId === "bash"`. Any zone that matches a non-bash tool while specifying `sandbox-then-auto` falls through to `ask` and emits `zone-ask-passthrough` with reason `non-bash-tool`.

---

## Default Risk Scorer

`createDefaultRiskScorer({ projectRoot })` composes three independent signals. The **highest tier wins** across signals; reasons accumulate across all signals.

| Signal | Critical | High | Medium | Low |
|--------|----------|------|--------|-----|
| **Path** | `**/.env*`, `~/.ssh/**`, `/etc/**` | `~/.aws/**`, `~/.config/**` | outside project root | inside project root |
| **Tool** | — | `bash` (deferred to AST signal) | `write`, `edit`, `multi-edit`, `patch` | `read`, `glob`, `grep`, `ls` |
| **Bash AST** | `rm -rf`, `dd`, `> /dev/sd*`, `curl \| sh` | network egress, `sudo`, package-manager mutate | git mutations, filesystem writes | `ls`, `cat`, `pwd`, `which`, `echo` |

The bash AST signal is only computed when `toolId === "bash"`. If AST parsing fails, the scorer conservatively assumes `high`. Tools whose risk the AST scorer cannot classify default to `low` unless the path or tool signal scores higher.

---

## Custom Risk Scorer

```typescript
import type { RiskAssessment, RiskInputs, RiskScorer } from "@koi/approval-zones";

// Minimal scorer: every call is medium risk
const conservativeScorer: RiskScorer = {
  score(_inputs: RiskInputs): RiskAssessment {
    return { tier: "medium", reasons: ["conservative-policy"] };
  },
};
```

The `score` method may return `RiskAssessment` or `Promise<RiskAssessment>`. Implement a custom scorer when the default heuristics are too permissive or too strict for your environment, or when you want ML-based classification.

---

## Default Profiles

| Profile export | Zone summary | Intended use |
|----------------|--------------|--------------|
| `READ_ONLY_PROFILE` | Auto-approves `read`, `glob`, `grep`, `ls` when risk ≤ `low` | Interactive exploration sessions; no mutations |
| `EDIT_TEST_FILES_PROFILE` | Auto-approves `write` and `edit` targeting `**/*.test.ts`, `**/*.test.js`, `**/__tests__/**` when risk ≤ `low` | Test-only editing workflows |
| `SCRIPTED_CLEANUP_PROFILE` | `sandbox-then-auto` for `bash` calls targeting `/tmp/**` when risk ≤ `medium` | Automated cleanup scripts; requires a sandbox backend |

Import from `@koi/approval-zones`:

```typescript
import {
  EDIT_TEST_FILES_PROFILE,
  READ_ONLY_PROFILE,
  SCRIPTED_CLEANUP_PROFILE,
} from "@koi/approval-zones";
```

---

## Audit Events

All zone events are recorded as `kind: "tool_call"` audit entries with a `metadata.permissionEvent` field. Every zone event carries shared metadata:

```typescript
{ zoneName: string; riskTier: RiskTier; riskReasons: readonly string[] }
```

| Event | When emitted |
|-------|-------------|
| `zone-auto` | Zone matched, `action === "auto"`, risk ≤ `maxRisk`; tool will execute on host |
| `zone-sandbox-preview` | `sandbox-then-auto` matched; sandbox execution is starting |
| `zone-sandbox-ok` | Sandbox execution succeeded; host re-execution will follow |
| `zone-sandbox-failed` | Sandbox threw or exited non-zero; falling back to `ask` |
| `zone-ask-passthrough` | Zone matched but action blocked (risk exceeded, missing backend, or non-bash tool); falling back to `ask` |

`zone-auto` is also emitted after a successful sandbox preview when the host re-run is approved — one `zone-sandbox-ok` is followed by one `zone-auto`.

---

## Error / Fail-Safe Semantics

All failures resolve toward prompting the user rather than silently allowing.

| Failure | Behavior |
|---------|----------|
| Zone matcher throws | Treat as no-match; fall through to `ask` |
| Risk scorer throws | Assume `critical`; fall through to `ask` |
| Sandbox router throws or exits non-zero | Audit `zone-sandbox-failed`; fall through to `ask` |
| `sandbox-then-auto` zone missing `sandboxBackendId` | Audit `zone-ask-passthrough` (reason: `missing-backend`); fall through to `ask` |
| `sandbox-then-auto` matched on non-bash tool | Audit `zone-ask-passthrough` (reason: `non-bash-tool`); fall through to `ask` |

---

## Limitations (v1)

- **`sandbox-then-auto` is bash-only.** Other tools that match a `sandbox-then-auto` zone fall through to `ask`. This is a deliberate v1 restriction; wrapping arbitrary Koi tools in a sandbox requires a full tool-host runtime inside the sandbox.

- **Two physical executions per `sandbox-then-auto` call.** The preview run is discarded (filesystem and network changes do not persist). Only the host re-run has side effects. Zone authors should still prefer idempotent operations: if the agent is interrupted between the sandbox approval and the host re-run, the host execution may never occur.

- **Zone-driven auto-approve does not populate persistent approvals.** Each call is re-evaluated against zones on every invocation. Persistent `always-allow` grants are managed separately by the approval store in `@koi/middleware-permissions`.

- **Risk scorer is heuristic.** The default scorer uses glob and AST rules and will produce false positives and negatives. Callers with stricter compliance requirements should supply a custom `RiskScorer`.
