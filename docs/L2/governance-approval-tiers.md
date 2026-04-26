# @koi/governance-approval-tiers — Persistent approval allowlist with tier support

Pairs with `@koi/governance-core` gov-11 ask-verdict plumbing to give users durable approvals across sessions. Every `ask` verdict the user answers with scope "always" is appended to `~/.koi/approvals.json` as a JSON-lines record; on future turns the wrapper short-circuits the `ask` to `ok: true` when a stored grant matches, so the user is not prompted twice.

## Why It Exists

`@koi/governance-core` already owns the session cache and the timeout, but on process restart every `always` decision is lost. Gov-12 closes the loop: append on grant, load on match, never prompt again for content the user has already signed off on. An alias layer lets downstream permission renames (e.g., `bash_exec` → `bash`) migrate without invalidating existing grants, and an optional delta-audit adapter emits a synthetic info-severity violation through the host's existing `onViolation` callback so gov-2 audit sinks record the decision trail immutably.

## Architecture

```
user turn
   │
   ▼
governance middleware (gov-11)
   │   evaluator.evaluate(request)
   ▼
wrapBackendWithPersistedAllowlist  ◄── gov-12
   │   if ok:"ask" and store.match hit → return ok:true
   │   else → passthrough
   ▼
ApprovalHandler (TUI / channel)
   │   user picks once / session / always
   ▼
if always → onApprovalPersist(grant)
   │
   ▼
createPersistSink(store)  ◄── gov-12
   │   store.append(...)
   │
   ├── wrapped by createViolationAuditAdapter  ◄── gov-12 (optional)
   │         └── onViolation(info:approval.persisted)
   │               └── @koi/audit-sink-* (gov-2)
   ▼
~/.koi/approvals.json  (JSON-lines, append-only)
```

### Layer position

- L0: `@koi/core` (PersistentGrant, PolicyRequest, GovernanceVerdict types)
- L0u: `@koi/hash` (computeGrantKey), `@koi/errors`
- L2 peer: `@koi/governance-core` (emits the `onApprovalPersist` callback that this package handles)

### Internal module map

- `types.ts` — ApprovalScope, PersistedApproval, ApprovalStore, AliasSpec, ApprovalQuery
- `aliases.ts` — applyAliases(kind, payload, specs)
- `jsonl-store.ts` — createJsonlApprovalStore({ path, aliases? })
- `backend-wrapper.ts` — wrapBackendWithPersistedAllowlist(backend, store)
- `persist-sink.ts` — createPersistSink(store)
- `violation-audit.ts` — createViolationAuditAdapter({ sink, onViolation })

## API

### `createJsonlApprovalStore({ path, aliases? })`

```typescript
const store = createJsonlApprovalStore({
  path: `${process.env.HOME}/.koi/approvals.json`,
  aliases: [{ kind: "tool_call", field: "tool", from: "bash_exec", to: "bash" }],
});
```

- Missing file → empty allowlist (not an error).
- Malformed JSONL lines → skipped, remaining entries still load.
- Concurrent `append` calls serialise via an internal promise chain.
- Parent directory is created on first write.

### `wrapBackendWithPersistedAllowlist(backend, store)`

Produces a new `GovernanceBackend` where `evaluator.evaluate()` returns `GOVERNANCE_ALLOW` in place of an `ok:"ask"` verdict when the store has a matching grant. All other sub-interfaces (`constraints`, `compliance`, `violations`, `dispose`, `describeRules`) pass through untouched.

### `createPersistSink(store)`

Returns a `PersistentGrantCallback` to wire into `GovernanceMiddlewareConfig.onApprovalPersist`. Converts the session-scoped `PersistentGrant` into a content-scoped `PersistedApproval` by dropping `agentId` and `sessionId`.

### `createViolationAuditAdapter({ sink, onViolation })`

Wraps any `PersistentGrantCallback` so every append also emits a synthetic `Violation { rule: "approval.persisted", severity: "info" }` through the host's existing `onViolation` channel. Gov-2 audit sinks pick it up automatically.

## Fail-Closed Contract

- Store read errors → return `undefined` from `match`; caller falls through to `ask`. The user gets prompted rather than silently allowed.
- Store write errors → bubble up as typed `KoiError`; caller decides whether to retry.
- The wrapper NEVER upgrades a denial (`ok: false`) to an allow. It only strips `ok: "ask"` when a durable grant exists.

## Persistence

File: `~/.koi/approvals.json` (override via `path`). One JSON object per line.

```
{"kind":"tool_call","payload":{"tool":"bash","cmd":"ls"},"grantKey":"a3f2…","grantedAt":1713974400000}
{"kind":"tool_call","payload":{"tool":"bash","cmd":"rm"},"grantKey":"b8c1…","grantedAt":1713974500000}
```

Append-only. Existing lines are never mutated. Migrations happen via `AliasSpec` at read time, not by rewriting history.

## See Also

- `@koi/governance-core` — emits the `ok:"ask"` verdict and the `onApprovalPersist` callback that this package handles.
- `@koi/audit-sink-ndjson`, `@koi/audit-sink-sqlite` — gov-2 audit destinations that receive the delta-audit record.
- Tracking issue: #1879 (parent #1208).
