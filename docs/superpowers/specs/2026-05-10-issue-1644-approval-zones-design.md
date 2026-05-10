# Approval Zones with Sandboxed Execution — Design

**Issue**: [#1644](https://github.com/windoliver/koi/issues/1644) — v2 Phase 3
**Status**: Design — pending implementation
**Depends on (closed)**: #1622 three-state permissions, #1634 bash AST, #1641 multi-backend executor

---

## Problem

After 10–40 approvals per session, users approve without reading. The safety model collapses. Granular zones + sandboxed execution within trusted zones + hard prompts for high-risk operations is the most credible mitigation.

## Goals

1. Define **approval zones** that map (tool × path × args) to one of three actions: `auto`, `ask`, `sandbox-then-auto`.
2. Score each tool call's **risk** from path sensitivity, tool category, and bash AST semantics.
3. Auto-approve only when matched zone permits **and** risk ≤ zone's `maxRisk`.
4. Run `sandbox-then-auto` calls in an isolated executor first; on success, re-execute on host with auto-approve. On sandbox failure, fall back to `ask`.
5. Emit an audit event for every auto-approve and every zone decision.
6. Ship 3 default profiles: `read-only`, `edit-test-files`, `scripted-cleanup`.
7. Allow user-supplied risk scoring via a pluggable `RiskScorer` interface.

## Non-goals (v1)

- Diff-and-replay or overlayfs commit semantics. Sandbox is a **read-only preview** model — side effects are discarded; tool re-runs on host.
- Wiring a specific sandbox backend (docker/e2b/daytona). Zones reference a `sandboxBackendId`; `@koi/sandbox/sandbox-router` resolves it from existing user config.
- ML-based risk classification. Default scorer is rule-driven; pluggable for future ML scorers.
- Cross-session learned zones. Zones are config; user grants are still handled by existing persistent-approvals.

## Architecture

New L2 package `@koi/security/approval-zones`. Layer-clean dependencies:

| From | To | Why |
|------|-----|-----|
| `@koi/security/approval-zones` | `@koi/core` | Types only |
| `@koi/security/approval-zones` | `@koi/lib/bash-ast`, `@koi/lib/bash-classifier` | Risk scoring on bash commands |
| `@koi/security/approval-zones` (peer) | `@koi/sandbox/sandbox-router` | Sandbox-then-auto execution. Optional peer — wiring lives in middleware-bridge module so zones core stays sandbox-free |
| `@koi/security/middleware-permissions` | `@koi/security/approval-zones` | Consumes zone evaluator at the `ask` interception point |

Existing rule evaluator semantics are unchanged. Zones intervene **only** when the rule evaluator returns `ask` — they cannot override `allow` or `deny`.

### Component summary

| Component | Purpose | Pure? |
|-----------|---------|-------|
| `zone-types.ts` | `ApprovalZone`, `ZoneAction`, `ZoneMatch`, `ZoneVerdict` types | n/a |
| `risk-types.ts` | `RiskTier`, `RiskInputs`, `RiskScorer` interface | n/a |
| `zone-match.ts` | Match a `PermissionQuery` against a zone's `match` block (glob-based) | yes |
| `risk-scorer.ts` | Default `RiskScorer` composing path / tool / bash-AST signals | yes |
| `evaluator.ts` | Combine zone match + risk score → `ZoneVerdict` | yes |
| `default-profiles.ts` | 3 ready-made `readonly ApprovalZone[]` bundles | yes |
| `middleware-bridge.ts` | Wires evaluator + sandbox-router into permissions middleware | async (orchestration) |

All files target < 200 LOC, well under the 400-line guideline.

## Data flow

```
tool call
  └─ permissions middleware
      ├─ rule evaluator → allow/deny → unchanged path
      └─ rule evaluator → ask
          └─ zone evaluator (sync)
              ├─ no zone matches → existing ask prompt
              ├─ zone matched, risk > maxRisk → audit("zone-ask-passthrough") → existing ask prompt
              ├─ zone matched, action=auto → audit("zone-auto") → execute on host
              └─ zone matched, action=sandbox-then-auto
                  └─ sandbox-router.execute(call, backendId)
                      ├─ ok → audit("zone-sandbox-ok") → re-execute on host → audit("zone-auto")
                      └─ failed/threw → audit("zone-sandbox-failed") → existing ask prompt
```

Two physical executions per `sandbox-then-auto` call. Tools that are not idempotent should not be wrapped in `sandbox-then-auto`; the default profile for cleanup operations documents this constraint.

## Type sketch

```ts
// zone-types.ts (L0-style)
export type ZoneAction = "auto" | "ask" | "sandbox-then-auto";

export interface ZoneMatch {
  readonly tools?: readonly string[];                   // toolId globs: ["read", "bash"]
  readonly paths?: readonly string[];                   // glob: ["**/*.test.ts", "/tmp/**"]
  readonly args?: Readonly<Record<string, string>>;     // arg-key → glob predicate
}

export interface ApprovalZone {
  readonly name: string;
  readonly match: ZoneMatch;
  readonly action: ZoneAction;
  readonly maxRisk?: RiskTier;                          // default: "low"
  readonly sandboxBackendId?: string;                   // required when action="sandbox-then-auto"
}

export type ZoneVerdict =
  | { readonly kind: "auto"; readonly zone: string; readonly risk: RiskTier }
  | { readonly kind: "sandbox"; readonly zone: string; readonly risk: RiskTier; readonly backendId: string }
  | { readonly kind: "ask"; readonly reason: "no-match" | "risk-exceeded" | "missing-backend" };
```

```ts
// risk-types.ts
export type RiskTier = "low" | "medium" | "high" | "critical";

export interface RiskInputs {
  readonly toolId: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly resource?: string | undefined;
  readonly bashCommand?: string | undefined;
}

export interface RiskAssessment {
  readonly tier: RiskTier;
  readonly reasons: readonly string[];                  // human-readable, audit-friendly
}

export interface RiskScorer {
  score(inputs: RiskInputs): RiskAssessment | Promise<RiskAssessment>;
}
```

## Default risk scorer

Composes three signals; **highest tier wins**. Reasons accumulate across signals.

| Signal | Critical | High | Medium | Low |
|--------|----------|------|--------|-----|
| **Path** | `**/.env*`, `~/.ssh/**`, `/etc/**` | `~/.aws/**`, `~/.config/**` | outside project root | inside project root |
| **Tool** | n/a | `bash` (defer to AST) | `write`, `edit` | `read`, `glob`, `grep` |
| **Bash AST** (via `bash-classifier`) | `rm -rf`, `dd`, `> /dev/sd*`, `curl \| sh` | network egress, `sudo`, package-manager mutate | git mutations, fs writes | `ls`, `cat`, `pwd`, `which` |

Bash signal is computed only when `toolId === "bash"` and AST parsing succeeds. AST parse failure → assume `high` (conservative).

## Default profiles

```ts
export const READ_ONLY_PROFILE: readonly ApprovalZone[] = [{
  name: "read-only",
  match: { tools: ["read", "glob", "grep", "ls"] },
  action: "auto",
  maxRisk: "low",
}];

export const EDIT_TEST_FILES_PROFILE: readonly ApprovalZone[] = [{
  name: "edit-test-files",
  match: { tools: ["write", "edit"], paths: ["**/*.test.ts", "**/*.test.js", "**/__tests__/**"] },
  action: "auto",
  maxRisk: "low",
}];

export const SCRIPTED_CLEANUP_PROFILE: readonly ApprovalZone[] = [{
  name: "scripted-cleanup",
  match: { tools: ["bash"], paths: ["/tmp/**"] },
  action: "sandbox-then-auto",
  maxRisk: "medium",
  sandboxBackendId: "default",
}];
```

## Middleware integration

One new optional field on `createPermissionsMiddleware`:

```ts
createPermissionsMiddleware({
  backend,
  zones: {
    evaluator: createZoneEvaluator({ zones, scorer }),
    sandboxRouter,                                      // optional: required iff any zone has action="sandbox-then-auto"
  },
});
```

Behavioral guarantees:
- Omitting `zones` config → existing behavior unchanged.
- Zone evaluator only consulted when backend verdict is `ask`. Persistent-approval cache and session approvals run **before** zone evaluation (they are user-granted; zones are policy-implied).
- Zone-driven auto-approve does **not** populate persistent approvals. Each call is re-evaluated.

## Audit events

Extend the existing `metadata.permissionEvent` taxonomy:

| Event | Trigger |
|-------|---------|
| `zone-auto` | Zone matched, action=auto, risk ≤ maxRisk, executed |
| `zone-sandbox-preview` | Sandbox execution started |
| `zone-sandbox-ok` | Sandbox succeeded; host execution will run next |
| `zone-sandbox-failed` | Sandbox failed/threw; falling back to ask |
| `zone-ask-passthrough` | Zone matched but maxRisk exceeded or missing backend; falling back to ask |

Every zone audit entry carries:
```ts
{ zoneName: string; riskTier: RiskTier; riskReasons: readonly string[] }
```

## Error handling (fail-safe)

| Failure | Behavior | Rationale |
|---------|----------|-----------|
| Zone matcher throws | Treat as no-match → ask | Never silently allow on matcher bug |
| Risk scorer throws | Assume `critical` → ask | Conservative |
| Sandbox router throws / non-zero exit | Audit `zone-sandbox-failed` → ask | Never auto-approve on infra error |
| `sandbox-then-auto` zone missing `sandboxBackendId` | Audit `zone-ask-passthrough` (reason: `missing-backend`) → ask | Config error fails open to existing prompt, never auto-approve |

## Testing

Test files colocate with source. `bun:test` runner. ≥ 80% coverage.

| Test file | Covers |
|-----------|--------|
| `zone-match.test.ts` | tool/path/args glob matching, multi-zone first-match precedence, empty-match edge case |
| `risk-scorer.test.ts` | path tier mapping, tool tier mapping, bash AST integration, composition (highest wins), AST parse-failure fallback |
| `evaluator.test.ts` | each (zone-action × risk × maxRisk) combo, missing-backend detection, no-match path |
| `middleware-bridge.test.ts` | full integration with mock permissions backend + mock sandbox router; asserts audit events |
| `default-profiles.test.ts` | each of 3 profiles matches expected positive cases and refuses expected negative cases |

Acceptance-criteria mapping:
- [x] Zone schema with ≥ 3 actions → `ZoneAction` union has exactly 3
- [x] Sandbox-then-auto runs in isolated executor → `middleware-bridge.ts`
- [x] Risk scoring uses bash AST + path patterns → `risk-scorer.ts`
- [x] Auto-approve emits audit event → `zone-auto` event in middleware-bridge
- [x] At least 3 default profiles shipped → `default-profiles.ts`
- [x] Tests cover all 3 actions + risk score computation → `evaluator.test.ts` + `risk-scorer.test.ts`
- [x] Documented in `docs/L2/security-permissions.md` → cross-link section + new `docs/L2/security-approval-zones.md`

## File layout

```
packages/security/approval-zones/
  src/
    zone-types.ts
    zone-match.ts          + zone-match.test.ts
    risk-types.ts
    risk-scorer.ts         + risk-scorer.test.ts
    evaluator.ts           + evaluator.test.ts
    default-profiles.ts    + default-profiles.test.ts
    middleware-bridge.ts   + middleware-bridge.test.ts
    index.ts
  package.json
  tsconfig.json
  tsup.config.ts

docs/L2/security-approval-zones.md       (new)
docs/L2/security-permissions.md          (cross-link section appended)

packages/meta/runtime/
  scripts/record-cassettes.ts            (add zone-auto golden query)
  src/__tests__/golden-replay.test.ts    (assert zone audit events)
  fixtures/zone-auto.cassette.json       (recorded)
  fixtures/zone-auto.trajectory.json     (recorded)
```

## Open questions resolved during brainstorm

| Q | Decision |
|---|----------|
| Package boundary | New `@koi/security/approval-zones` |
| Eval order | Pre-ask interceptor (zones never override allow/deny) |
| Sandbox merge model | Read-only preview; tool re-runs on host |
| Risk shape | Discrete tiers: low/medium/high/critical |
| Sandbox backend wiring | Reference by ID; sandbox-router resolves |

## Risks

- **Two-execution cost for sandbox-then-auto.** Documented constraint; profile authors choose. Mitigated by limiting default profile to `/tmp/**` cleanup.
- **Risk scorer false-negatives.** The default scorer is heuristic. Pluggable `RiskScorer` interface lets users override. Critical-tier defaults err conservative.
- **Zone matcher complexity creep.** Schema deliberately small for v1 (tools, paths, args). Resist adding env-var, time-of-day, network predicates until real demand.
