# Single-Tier Verification

Koi uses a single-tier verification model for forged bricks (tools, skills, agents).
Every forged artifact passes one verification gate — "does this code crash?" — and
declares its required capabilities upfront. Runtime safety is delegated entirely to
governance middleware.

---

## Why single-tier?

The previous 3-tier graduation model (sandbox → verified → promoted) was over-engineered:

```
  Problem with tiered graduation:

  1. Network-dependent tools could never pass sandbox verification
     (network was always denied), so they were dead on arrival.

  2. Auto-promotion thresholds (5 uses → verified, 20 → promoted)
     conflated "frequently used" with "safe to trust".

  3. Governance middleware (permissions, audit, guardrails) already
     gates every tool call at runtime — tiered graduation was
     redundant for runtime safety.

  4. Tiered executor dispatch added indirection without security
     benefit — the same subprocess executor ran for all tiers.
```

Single-tier verification solves this by separating two concerns:

| Concern | Handled by | When |
|---------|-----------|------|
| **"Does this code crash?"** | Forge verification pipeline | Once, at forge time |
| **"Should this call be allowed?"** | Governance middleware | Every runtime call |

---

## How it works

### Forge-time: verification with full network access

Verification always allows network — the sandbox just checks "does this code crash?":

```typescript
// Network-dependent tools just work during verification
const tool = await forge("fetch-weather", {
  code: `const res = await fetch("https://api.weather.com/forecast");
         return await res.json();`,
});
```

The verification pipeline always allows network during the "does it crash?" check:

```
  forge("fetch-weather", { ... })
    │
    ▼
  verify.ts
    ├── subprocess-executor.execute(code, input, timeout, {
    │     networkAllowed: true,      ← always allowed during verification
    │     resourceLimits: { ... },
    │   })
    ├── static analysis (AST checks)
    ├── self-test generation
    └── SandboxResult { ok: true } → BrickArtifact stored
```

Network access is always granted during verification. Runtime governance middleware
decides whether a specific call should be allowed.

### Runtime: governance middleware gates every call

Once verified, the brick is available. But every runtime invocation passes through
the middleware chain:

```
  agent calls tool "fetch-weather"
    │
    ▼
  middleware chain
    ├── permissions middleware    → "is this agent allowed to call this tool?"
    ├── audit middleware          → "log this call for compliance"
    ├── guardrails middleware     → "does input/output violate policies?"
    ├── pay middleware            → "does this agent have budget?"
    └── rate-limit middleware     → "too many calls?"
    │
    ▼
  tool executes (promoted-executor, in-process)
```

This is the same middleware chain that gates all tool calls — forged or built-in.
No special treatment for forged tools.

---

## Trust tiers still exist

Trust tiers (`sandbox`, `verified`, `promoted`) remain as labels, but promotion
is **manual only** via the `promote_forge` tool:

```typescript
// Human-initiated promotion (no auto-graduation)
await promoteForgeTool({ brickId: "sha256:abc123", targetTier: "promoted" });
```

| Tier | Meaning | How to reach |
|------|---------|-------------|
| `sandbox` | Freshly forged, passed verification | Default after forge |
| `verified` | Human reviewed and approved | Manual `promote_forge` |
| `promoted` | Fully trusted, runs in-process | Manual `promote_forge` |

What was removed:
- Auto-promotion based on usage count
- Trust demotion (use lifecycle quarantine instead)
- Tiered executor dispatch (`TieredSandboxExecutor`)
- Priority re-verification queues (now single FIFO)

---

## What this enables

### 1. Network-dependent tools work out of the box

```typescript
// Before: ❌ Dead on arrival — network denied in sandbox
// After:  ✅ Passes verification — network always allowed
await forge("slack-notify", {
  code: `await fetch("https://hooks.slack.com/...", {
           method: "POST", body: JSON.stringify({ text: input.message })
         });`,
});
```

### 2. Simpler mental model

One question at forge time: "does this code crash?"
One answer at runtime: "does governance allow this call?"

No graduation ceremony. No usage thresholds. No tier arithmetic.

### 3. Faster executor path

Direct `SandboxExecutor.execute()` call — no tiered dispatcher indirection.
~250 lines of dispatch/resolution code removed.

### 4. Capability declarations as documentation

`BrickRequires` serves as both a runtime contract (sandbox profile) and
human-readable documentation of what a tool needs:

```typescript
interface BrickRequires {
  readonly network?: boolean;    // needs outbound network
  // future: filesystem, gpu, etc.
}
```

---

## Executor architecture

Two executors remain in `@koi/sandbox-executor`, used directly (no dispatcher):

```
  ┌─────────────────────────────────────────┐
  │  Forge verification                      │
  │  createSubprocessExecutor()              │
  │                                          │
  │  ● Separate process (Bun.spawn)          │
  │  ● OS sandbox (Seatbelt / Bubblewrap)    │
  │  ● Network allowed/denied per requires   │
  │  ● Resource limits (ulimit)              │
  │  ● Timeout + SIGKILL                     │
  └─────────────────────────────────────────┘

  ┌─────────────────────────────────────────┐
  │  Runtime execution                       │
  │  createPromotedExecutor()                │
  │                                          │
  │  ● In-process (import() / new Function)  │
  │  ● LRU cached (256 entries)              │
  │  ● Promise.race timeout                  │
  └─────────────────────────────────────────┘
```

---

## Related

- [Koi Architecture](./Koi.md) — system overview and layer rules
- [@koi/forge](../L2/forge.md) — self-extension runtime
- [@koi/sandbox-executor](../L2/sandbox-executor.md) — executor backends
- `@koi/core` — L0 contract definitions (`SandboxExecutor`, `BrickRequires`)
