# gov-11: Ternary GovernanceVerdict — allow / deny / ask

**Issue:** [#1878](https://github.com/windoliver/koi/issues/1878)
**Parent umbrella:** #1208 (v2 Phase 3: governance)
**Depends on:** #1392 (gov-1, merged in PR #1872)
**Unblocks:** gov-12 (approval tiers), gov-5 (permissions-nexus HITL)
**Date:** 2026-04-23
**Estimated LOC:** ~400

## Motivation

The L0 `GovernanceVerdict` discriminated union is currently binary: `ok: true | false`. Any governance backend that wants to ask the user ("approve this tool call?") must pre-declare an allowlist. There is no primitive for suspending a `gate()` check awaiting async human input — a core HITL (human-in-the-loop) workflow.

The permissions middleware already has a working HITL plumbing:
`PermissionDecision.effect === "ask"` →
`handleAskDecision` →
`ctx.requestApproval(ApprovalRequest) → Promise<ApprovalDecision>` →
channel (TUI, Slack, etc.).

This design extends the same primitive to governance without duplicating the plumbing.

## Scope

Only the verdict-extension + `gate()` integration land here. Persistent always-allow storage is gov-12. Nexus-backed HITL routing is gov-5.

## Architectural decisions (brainstormed)

| Decision | Choice | Reason |
|----------|--------|--------|
| HITL plumbing | Reuse `ctx.requestApproval: ApprovalHandler` | L0 + channels already wired for permissions; duplicating is churn |
| New package `@koi/governance-approvals` | **Dropped** | Reuse path makes a parallel registry unnecessary |
| Decision mapping | `allow` → proceed · `always-allow` → proceed + grant · `modify` → reject · `deny` → throw | governance asks cannot modify policy input |
| "Always" persistence | Callback `onApprovalPersist` in `GovernanceMiddlewareConfig` | Decouples gov-11 from gov-12; gov-12 plugs into the callback |
| Timeout config | New `approvalTimeoutMs` on `GovernanceMiddlewareConfig` (default 60_000) | Independent from permissions' timeout |

## Changes

### L0 — `@koi/core/governance-backend.ts`

Extend the discriminated union and add the `AskId` brand:

```ts
declare const __askIdBrand: unique symbol;
export type AskId = string & { readonly [__askIdBrand]: "AskId" };
export const askId = (s: string): AskId => s as AskId;

export type GovernanceVerdict =
  | { readonly ok: true; readonly diagnostics?: readonly Violation[] | undefined }
  | { readonly ok: false; readonly violations: readonly Violation[] }
  | {
      readonly ok: "ask";
      readonly prompt: string;
      readonly askId: AskId;
      readonly metadata?: JsonObject | undefined;
    };
```

Type guard (pure, L0-legal):

```ts
export const isAskVerdict = (v: GovernanceVerdict): v is Extract<GovernanceVerdict, { ok: "ask" }>
  => v.ok === "ask";
```

Existing `.ok === true` and `.ok === false` checks narrow correctly under the extended union.

L0 index (`packages/kernel/core/src/index.ts`) re-exports `AskId`, `askId`, `isAskVerdict`.

### L2 — `@koi/governance-core` `gate()` integration

File: `packages/security/governance-core/src/governance-middleware.ts`

After the existing `verdict = await backend.evaluator.evaluate(request)` block, branch on `verdict.ok === "ask"`:

```ts
if (verdict.ok === "ask") {
  const grantKey = computeGrantKey(kind, payload);

  // Fast-path: session-scoped grant already covers this (kind, payload).
  if (sessionGrants.get(sessionId)?.has(grantKey)) {
    emitCompliance(request, kind, GOVERNANCE_ALLOW);
    return;
  }

  if (!ctx.requestApproval) {
    throw KoiRuntimeError.from("PERMISSION",
      "Governance verdict requires approval but no handler configured", { ... });
  }

  // Coalesce identical in-flight asks by askId.
  let pending = inflightAsks.get(verdict.askId);
  if (!pending) {
    const approvalReq: ApprovalRequest = {
      toolId: `governance:${kind}`,
      input: payload,
      reason: verdict.prompt,
      metadata: { askId: verdict.askId, ...verdict.metadata },
    };
    pending = withTimeout(
      ctx.requestApproval(approvalReq),
      approvalTimeoutMs,
      ensureSessionAbort(sessionId).signal,
    );
    inflightAsks.set(verdict.askId, pending);
    pending.finally(() => inflightAsks.delete(verdict.askId));
  }

  let decision: ApprovalDecision;
  try {
    decision = await pending;
  } catch (e) {
    if (isApprovalTimeout(e)) {
      throw KoiRuntimeError.from("TIMEOUT", `Approval timed out after ${approvalTimeoutMs}ms`, {
        cause: e,
        context: { agentId, sessionId, kind, askId: verdict.askId },
      });
    }
    throw KoiRuntimeError.from("PERMISSION", "Approval handler failed", {
      cause: e,
      context: { agentId, sessionId, kind, askId: verdict.askId },
    });
  }

  switch (decision.kind) {
    case "allow":
      emitCompliance(request, kind, GOVERNANCE_ALLOW);
      return;
    case "always-allow":
      ensureSessionGrantSet(sessionId).add(grantKey);
      if (decision.scope === "always") {
        onApprovalPersist?.({
          kind, agentId, sessionId, payload, grantKey,
          grantedAt: Date.now(),
        });
      }
      emitCompliance(request, kind, GOVERNANCE_ALLOW);
      return;
    case "deny":
      throw KoiRuntimeError.from("PERMISSION", decision.reason || verdict.prompt, {
        context: { agentId, sessionId, kind, askId: verdict.askId },
      });
    case "modify":
      throw KoiRuntimeError.from("PERMISSION",
        "Governance asks do not support input modification", {
          context: { agentId, sessionId, kind, askId: verdict.askId },
        });
  }
}
```

### New middleware-scoped state (closure)

```ts
const sessionGrants = new Map<SessionId, Set<string>>();
const inflightAsks = new Map<AskId, Promise<ApprovalDecision>>();
const sessionAborts = new Map<SessionId, AbortController>();   // one per active session
```

`ensureSessionAbort(sessionId)` returns (or lazily inserts) the per-session `AbortController`. The `withTimeout` call uses that controller's `signal` so session-teardown can cancel inflight approval promises.

`onSessionEnd(sessionId)` hook:
1. `sessionAborts.get(sessionId)?.abort()` — rejects all inflight asks tied to that session with PERMISSION.
2. `sessionAborts.delete(sessionId)`.
3. `sessionGrants.delete(sessionId)`.

`inflightAsks` is keyed by `AskId` only (backends MUST generate globally-unique askIds; this is a documented invariant on the `GovernanceVerdict.ask` variant).

### New helper files

**`packages/security/governance-core/src/grant-key.ts`**

Stable canonical JSON hash:

```ts
export function computeGrantKey(kind: PolicyRequestKind, payload: JsonObject): string {
  const canonical = canonicalJsonStringify({ kind, payload });
  return sha256Hex(canonical);
}
```

Uses `crypto.subtle.digest` (Bun built-in). Sort object keys recursively, arrays preserve order.

**`packages/security/governance-core/src/with-timeout.ts`**

```ts
export class ApprovalTimeoutError extends Error { readonly name = "ApprovalTimeoutError"; }
export const isApprovalTimeout = (e: unknown): e is ApprovalTimeoutError
  => e instanceof ApprovalTimeoutError;

export function withTimeout<T>(p: Promise<T>, ms: number, abortSignal?: AbortSignal): Promise<T>;
```

Implementation uses `Promise.race` + `setTimeout` + optional `AbortSignal` short-circuit.

### Config additions

File: `packages/security/governance-core/src/config.ts`

```ts
export interface GovernanceMiddlewareConfig {
  // ... existing fields ...
  readonly approvalTimeoutMs?: number;                    // default 60_000
  readonly onApprovalPersist?: (grant: PersistentGrant) => void;
}

export interface PersistentGrant {
  readonly kind: PolicyRequestKind;
  readonly agentId: AgentId;
  readonly sessionId: SessionId;
  readonly payload: JsonObject;
  readonly grantKey: string;
  readonly grantedAt: number;
}

export const DEFAULT_APPROVAL_TIMEOUT_MS = 60_000 as const;
```

`validateGovernanceConfig` additions:
- `approvalTimeoutMs`: if present, positive finite integer; else fail.
- `onApprovalPersist`: if present, must be function; else fail.

### Index exports

`packages/security/governance-core/src/index.ts`:
- `type PersistentGrant`
- `DEFAULT_APPROVAL_TIMEOUT_MS`

## Tests

### L0 type tests — `packages/kernel/core/src/governance-backend.test.ts` (append)

- Union narrowing: `ok: true` / `ok: false` / `ok: "ask"` all narrow cleanly.
- `isAskVerdict` type guard works.
- `askId("abc")` returns branded string assignable to `AskId` but a plain `string` is not assignable without the constructor.

### New — `packages/security/governance-core/src/__tests__/ask-verdict.test.ts`

| Test | Asserts |
|------|---------|
| ask → allow | `gate()` resolves; compliance recorded as `GOVERNANCE_ALLOW`; handler called once |
| ask → always-allow (session) | Second identical call skips handler; `onApprovalPersist` NOT called |
| ask → always-allow (always) | Handler called; `onApprovalPersist` invoked with correct `PersistentGrant`; session grant also set |
| ask → deny | `KoiRuntimeError({code:"PERMISSION"})` thrown with decision reason |
| ask → modify | `KoiRuntimeError({code:"PERMISSION"})` thrown; message says "modification not supported" |
| no handler | `ctx.requestApproval === undefined` → PERMISSION thrown; handler never invoked |
| timeout | Fake timer past `approvalTimeoutMs` → `KoiRuntimeError({code:"TIMEOUT"})` |
| inflight coalescing | Two concurrent asks, same `askId` → handler invoked once |
| onSessionEnd | Pending ask rejects with PERMISSION; session grants dropped |
| payload fingerprint scoping | Grant for `{cmd:"ls"}` does NOT cover `{cmd:"rm"}` |
| kind scoping | Grant for `tool_call` does NOT cover `model_call` with same payload |
| config validation | `approvalTimeoutMs` -1/0/NaN/"60" all fail validation |

### New — `packages/security/governance-core/src/with-timeout.test.ts`

- Resolves with the promise value when it resolves before timeout fires.
- Rejects with `ApprovalTimeoutError` when timeout fires first (use fake timers).
- Rejects with `AbortError` (or PERMISSION-typed wrap) when the passed `AbortSignal` fires.
- Clears the timeout on resolution — no dangling handles.

### New — `packages/security/governance-core/src/grant-key.test.ts`

- Key-order independence: `{a:1,b:2}` and `{b:2,a:1}` produce identical hash.
- Nested object stability.
- Array order preserved (arrays are ordered).
- Different `kind` → different hash.
- SHA-256 hex output (64 chars `/^[0-9a-f]{64}$/`).

### Regression — `governance-middleware.test.ts`

- Existing binary-backend tests continue to pass unchanged.

### Coverage

Target ≥ 80% (bunfig threshold). New branches all exercised by the matrix above.

## Security review

- **Fail-closed on handler absence**: `ctx.requestApproval === undefined` → PERMISSION throw. A backend that returns `ask` in a context without a handler cannot silently be treated as allow.
- **Timeout fails closed**: timeout → TIMEOUT throw, not allow.
- **Session grant scoping**: hash includes `kind + payload`, so approving one tool call cannot bleed into other actions.
- **Session grant lifetime**: grants dropped on `onSessionEnd`; persistent always-allow is gov-12's problem.
- **No persistence in this PR**: `onApprovalPersist` is an observation callback only; if the host wires nothing, "always" behaves identically to session-only.
- **Inflight coalescing by `askId`**: only backends that re-emit the same `askId` benefit from dedup — random per-call askIds produce no coalescing, which is the safe default.

## Anti-leak checklist

- [x] No framework-isms added to L0 (verdict extension uses only existing L0 types + new `AskId` brand)
- [x] Middleware remains the sole interposition point
- [x] All interface props `readonly`
- [x] L0 adds no imports from other packages
- [x] L2 governance-core imports only from L0 + L0u (`@koi/errors`, etc.)
- [x] No vendor types introduced

## Out of scope (explicitly)

- Persistent always-allow storage → gov-12
- Nexus ReBAC-backed asks → gov-5
- TUI approval panel polish → gov-9
- CLI `--ask-timeout` flag → gov-10 (if added)
- Modifying approval input for governance → intentionally rejected; asks are policy-scope, not input-scope

## File touch list

**Modify:**
- `packages/kernel/core/src/governance-backend.ts` — extend verdict union; add AskId brand + constructor + type guard.
- `packages/kernel/core/src/index.ts` — export new names.
- `packages/kernel/core/src/governance-backend.test.ts` — append union narrowing tests.
- `packages/security/governance-core/src/governance-middleware.ts` — ask branch in `gate()`; session grant map; inflight ask map; `onSessionEnd` handling.
- `packages/security/governance-core/src/config.ts` — new config fields + validation + `PersistentGrant` type + default timeout constant.
- `packages/security/governance-core/src/index.ts` — export `PersistentGrant`, `DEFAULT_APPROVAL_TIMEOUT_MS`.

**Create:**
- `packages/security/governance-core/src/grant-key.ts`
- `packages/security/governance-core/src/grant-key.test.ts`
- `packages/security/governance-core/src/with-timeout.ts`
- `packages/security/governance-core/src/with-timeout.test.ts`
- `packages/security/governance-core/src/__tests__/ask-verdict.test.ts`

## Definition of done

- [ ] All tests pass: `bun run test --filter=@koi/core --filter=@koi/governance-core`
- [ ] `bun run typecheck` clean
- [ ] `bun run lint` clean
- [ ] `bun run check:layers` clean
- [ ] `bun run check:unused` clean
- [ ] Coverage ≥ 80%
- [ ] Regression: existing governance-middleware tests unchanged, still pass
- [ ] Docs: update `docs/L2/governance-core.md` (or equivalent) with the ask verdict flow
