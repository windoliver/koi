# @koi/middleware-permissions — Persistent Approval Memory

Extends the permissions middleware with cross-session approval persistence. When a user grants "always-allow" with scope `"always"`, the decision is stored in SQLite and survives process restart.

---

## Approval Scopes

| Scope | Storage | Lifetime | Key |
|-------|---------|----------|-----|
| `once` | None (implicit) | Single tool call | N/A |
| `session` | In-memory Set | Until session end or `clearSessionApprovals` | `agentId + toolId` |
| `always` | SQLite via `ApprovalStore` | Until explicitly revoked | `userId + agentId + toolId` |

---

## Lookup Cascade

When a tool call triggers an `ask` verdict, the middleware checks in order:

```
1. Persistent store (SQLite)  →  hit? execute tool, emit "remembered"
2. Session always-allow set   →  hit? execute tool
3. Approval cache (TTL)       →  hit? execute tool
4. Prompt user                →  allow / deny / always-allow
```

If the user chooses `always-allow` with scope `"always"`, the grant is:
- Added to the session set (fast path for current session)
- Persisted to SQLite (survives restart)

---

## Configuration

```typescript
import { createApprovalStore, createPermissionsMiddleware } from "@koi/middleware-permissions";

const store = createApprovalStore({ dbPath: "./approvals.db" });

const mw = createPermissionsMiddleware({
  backend: myPermissionBackend,
  persistentApprovals: store,
});
```

Use `:memory:` for tests:

```typescript
const store = createApprovalStore({ dbPath: ":memory:" });
```

---

## Revocation

```typescript
// Revoke a specific grant
mw.revokePersistentApproval("user-1", "agent:main", "bash");

// Revoke all grants
mw.revokeAllPersistentApprovals();

// List all grants (for UI/diagnostics)
const grants = mw.listPersistentApprovals();
```

`clearSessionApprovals()` does NOT clear persistent grants — by design.

---

## TUI Key Bindings

| Key | Action | Scope |
|-----|--------|-------|
| `y` | Allow once | `once` |
| `n` | Deny | N/A |
| `a` | Always allow (session) | `session` |
| `!` | Always allow (permanent) | `always` |
| `Esc` | Deny and dismiss | N/A |

---

## Failure Semantics

| Failure | Behavior | Rationale |
|---------|----------|-----------|
| `has()` throws | Fall through to prompt | Fail-safe: more prompts, not silent allows |
| `grant()` throws | Tool still executes | Approval was given; permanence just not recorded |
| DB corrupt/locked | Falls back to prompt | WAL + `busy_timeout(3000)` mitigate most cases |

---

## Audit Events

Permission events are recorded as `kind: "tool_call"` audit entries with a `metadata.permissionEvent` field:

| Event | When |
|-------|------|
| `"asked"` | Backend returned `ask`, prompting user |
| `"granted"` | User allowed the tool call |
| `"denied"` | User denied the tool call |
| `"remembered"` | Persistent or session grant matched, skipping prompt |

---

## Security Considerations

- **Grant key includes `userId`** — prevents cross-user grant inheritance
- **Grant key includes `agentId`** — prevents child/sub-agent inheritance
- **No input-specific keying** — `always` scope means "trust this tool regardless of input." For input-sensitive approvals, use `session` scope
- **Prepared statements** — all SQLite queries use parameterized statements
- **WAL mode** — enables concurrent read/write access across sessions
