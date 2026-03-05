# Middleware Session Isolation

## Problem

Koi middleware instances are long-lived singletons — a single middleware object
serves multiple sessions (sequential or concurrent). Mutable state captured in
closures (`let` variables) persists across session boundaries unless explicitly
reset. This creates three classes of bugs:

```
Session A                          Session B (reuses same middleware)
─────────                          ─────────
  populate cache, buffers            sees Session A's stale data
  accumulate turn state              inherits turn counters, caches
  end session (partial cleanup)      acts on Session A's leftovers
```

### Concrete failure modes

| Category | Example | Impact |
|---|---|---|
| **Stale cache** | Compactor's `cachedRestore` from session A injected into session B | Ghost messages appear in new sessions |
| **Leaked counters** | Hot-memory's `turnCount` carries over | Refresh interval skewed, wrong memories injected |
| **Concurrent wipe** | User-model resets shared state when session A ends while session B is active | Session B loses accumulated sensor state mid-conversation |
| **Missing dedup** | Conversation captures the same message twice across model calls | Duplicate turns persisted to thread store |
| **Wrong role** | Conversation hardcodes `"user"` for all inbound messages | System and tool messages stored with wrong role |
| **Budget bypass** | ACE injects structured playbooks without checking remaining token budget | Context overflow, wasted tokens |

## Solution

Five targeted fixes enforce correct session isolation across middleware:

### 1. Reset all caches in `onSessionStart`

Every cached value must be cleared unconditionally at the top of `onSessionStart`,
before any I/O:

```typescript
// middleware-compactor: clear stale cachedRestore
async onSessionStart(ctx: SessionContext): Promise<void> {
  state = { ...state, cachedRestore: undefined };
  // ... then load fresh data
}

// middleware-hot-memory: reset all mutable state
onSessionStart(_ctx: SessionContext): void {
  initialized = false;
  turnCount = 0;
  hotCount = 0;
  cachedTokenCount = 0;
  cachedMessage = undefined;
}
```

**Pattern**: If a middleware has `let` variables, it needs an `onSessionStart` that
resets them. No exceptions.

### 2. Guard concurrent session cleanup

When middleware tracks active sessions, cleanup must be conditional:

```typescript
// middleware-user-model: only wipe shared state when last session ends
async onSessionEnd(ctx: SessionContext): Promise<void> {
  activeSessions.delete(ctx.sessionId as string);
  if (activeSessions.size === 0) {
    sensorState = {};
    recallCache = undefined;
    snapshotCache.invalidate();
  }
}
```

**Pattern**: `delete` then `if (size === 0)` — never wipe shared state while
other sessions are still active.

### 3. Derive message roles from sender identity

Never hardcode roles. Derive from `senderId`:

```typescript
function deriveRole(msg: InboundMessage): ThreadMessageRole {
  if (msg.senderId === sessionRef?.agentId) return "assistant";
  if (msg.senderId.startsWith("system")) return "system";
  if (msg.senderId.startsWith("tool")) return "tool";
  return "user";
}
```

### 4. Deduplicate captured messages

Track timestamps to prevent double-capture across multiple `wrapModelCall`
invocations within the same session:

```typescript
let capturedTimestamps = new Set<number>();

// In capture logic:
const fresh = request.messages.filter(
  (m) => !isFromHistory(m) && !capturedTimestamps.has(m.timestamp),
);
```

### 5. Enforce shared token budgets

When multiple playbook types share a budget, compute remaining budget after
each selection pass:

```typescript
const totalBudget = config.maxInjectionTokens ?? 500;
const selected = selectPlaybooks(statPlaybooks, { maxTokens: totalBudget });
const statTokensUsed = selected.reduce((sum, pb) => sum + estimateTokens(pb.strategy), 0);
const remainingBudget = totalBudget - statTokensUsed;
const filteredStructured = selectStructuredPlaybooks(structuredPlaybooks, remainingBudget);
```

---

## What This Enables

### For agent builders

- **Correct multi-session reuse** — middleware instances can be safely reused
  across sequential sessions without ghost state from previous sessions
- **Safe concurrent sessions** — multiple sessions sharing a middleware instance
  don't interfere with each other's accumulated state
- **Accurate conversation history** — messages persisted with correct roles and
  no duplicates, enabling reliable multi-turn dialogue
- **Predictable token budgets** — playbook injection stays within configured
  limits regardless of how many playbook types are active

### For users

- **No phantom context** — agents don't hallucinate based on a previous
  session's cached state
- **Consistent memory** — hot memories refresh correctly at session boundaries
  instead of serving stale data
- **Reliable role attribution** — system and tool messages are correctly
  attributed in conversation history

---

## Affected Packages

| Package | Fix | Priority |
|---|---|---|
| `@koi/middleware-compactor` | Clear stale `cachedRestore` in `onSessionStart` | P1 |
| `@koi/middleware-user-model` | Guard state cleanup for concurrent sessions | P1 |
| `@koi/middleware-conversation` | Derive roles from `senderId` + deduplicate messages | P1 |
| `@koi/middleware-hot-memory` | Add missing `onSessionStart` lifecycle hook | P2 |
| `@koi/middleware-ace` | Budget structured playbooks within shared token limit | P2 |

---

## Testing

Each fix includes regression tests that reproduce the original bug:

```bash
# Per-package
bun test packages/mm/middleware-compactor
bun test packages/mm/middleware-hot-memory
bun test packages/mm/middleware-user-model
bun test packages/mm/middleware-conversation
bun test packages/mm/middleware-ace

# Full middleware suite
bun test packages/mm/
```
