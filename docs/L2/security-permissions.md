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

---

## Soft Deny (#1650)

A rule may opt into soft-deny via `on_deny: "soft"`. Instead of throwing an error, the permissions middleware returns a synthetic `ToolResponse` containing only the tool ID. This allows the agent loop to adapt rather than immediately failing.

### Rule-Level Opt-In

Soft deny is per-rule, not inferred from tier or source:

```yaml
rules:
  - pattern: "/tmp/scratch/**"
    action: "*"
    effect: "deny"
    on_deny: "soft"          # opt-in: agent receives synthetic error, can adapt

  - pattern: "/etc/**"
    action: "write"
    effect: "deny"
                              # default hard — same as pre-#1650
```

**Default is hard for every rule tier.** Existing rules without `on_deny` keep pre-#1650 behavior exactly. Per-rule opt-in prevents silent behavior changes on policy updates.

### Synthetic Response

When a soft deny is triggered, `wrapToolCall` returns a `ToolResponse` instead of throwing:

```json
{
  "output": "Permission denied for tool \"<toolId>\". This tool is not available in the current scope.",
  "metadata": {
    "isError": true,
    "permissionDenied": true,
    "toolId": "<toolId>"
  }
}
```

The `output` contains only the tool ID, never the denial reason (trust boundary). The agent sees a graceful error and can offer alternatives or explain why the tool isn't available.

### Per-Turn Soft-Deny Cap

Soft denies are bounded per turn by a cumulative counter keyed on the decision cache key (the coarse context of the query). Default cap: **3 denies per `decisionCacheKey` per turn**, configurable via `softDenyPerTurnCap` in middleware config.

**Key behaviors:**

- **Cumulative within a turn** — each soft deny increments the counter for its cache key
- **Allow decisions do NOT reset** — prevents a model from indefinitely alternating denied/allowed calls on the same key to avoid the cap
- **Exceeding cap hard-converts** — the 4th deny (cap+1) is promoted to hard and throws
- **Cleared at turn boundary** — `onBeforeTurn` resets counters for a fresh turn

Example:

```
Turn 1:
  call 1: tool:read   → soft-deny  (count[read]=1, under cap)
  call 2: tool:read   → soft-deny  (count[read]=2, under cap)
  call 3: tool:read   → soft-deny  (count[read]=3, under cap)
  call 4: tool:read   → HARD-DENY  (count[read]=4, over cap, throws)

Turn 2:
  (counter cleared at turn boundary)
  call 1: tool:read   → soft-deny  (count[read]=1, under cap)
```

### Unkeyable Context

If the permission backend cannot extract a stable decision cache key (e.g., the query context is malformed or missing required fields), soft-deny fails closed: the middleware hard-throws instead of returning a synthetic response. This prevents cache-key collisions or confusion in edge cases where keying rules cannot be applied.

### Known Limitation: Cross-Tool Rotation

When the agent rotates between different tools with the same deny rule, each tool's cache key increments its own counter independently. In high-denial scenarios (many tools all hitting the same soft-deny rule), the combined effect can exceed the per-turn cap × tool count before hit the engine's max-iterations limit. The per-turn cap is bounded by its configuration, but the ultimate bound depends on how many distinct tools trigger soft denies.

**Classifier-driven query normalization** (separate follow-up) will address this by coalescing repeated probes on the same underlying resource into a single decision key, closing this gap at the query level rather than tool level.

### Audit Trail

Soft-deny events are recorded in an isolated per-session `SoftDenyLog` (internal, not exported). Hard-deny records go into the public `DenialTracker` as before. The `DenialRecord` type now includes optional `softness` ("soft" | "hard") and `origin` ("native" | "soft-conversion") fields:

- `origin: "native"` — produced by the rule evaluator or user approval deny
- `origin: "soft-conversion"` — promoted from soft to hard when exceeding per-turn cap

Mechanism A's session-wide escalation prefilter (see middleware-permissions.md) excludes records where `origin === "soft-conversion"` or `softness === "soft"`, so per-turn cap events do not metastasize into session-wide hard blocks.

### Follow-Up Work

The following are filed separately and not yet implemented:

- **Durable audit-sink interface** — persist soft-deny logs for post-session analysis
- **AbortSignal threading** — propagate turn-abort signals into soft-deny flow for responsive cancellation
- **Classifier-driven normalization** — coalesce repeated probes on same resource into single decision cache key

See issue #1650 for tracking.
