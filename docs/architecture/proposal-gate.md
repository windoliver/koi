# ProposalGate — Unified Change Governance Contract (L0)

A narrow L0 interface for submitting, reviewing, and watching agent-initiated structural change proposals. The gate requirement scales automatically with the blast radius of the target architectural layer — a sandboxed tool auto-approves in milliseconds; a kernel interface change blocks until a human signs off, a full test suite passes, and a new binary ships.

---

## Why It Exists

Before this contract, any agent could attempt structural changes with no enforcement boundary:

```
WITHOUT ProposalGate             WITH ProposalGate
────────────────────────         ─────────────────────────────────────

Agent forges tool         ──►    gate looks up PROPOSAL_GATE_REQUIREMENTS
No blast-radius check            brick:sandboxed → auto-approved, immediate
No HITL for kernel changes       l0_interface   → blocked: HITL + all-agents test

All change types treated         Requirements scale with architectural depth:
identically                        low blast = auto, immediate
                                   high blast = human + test suite + new binary

No lifecycle tracking            Proposals have status: pending → approved |
                                   rejected | superseded | expired

No event stream                  watch() delivers submitted/reviewed/expired/
                                   superseded events to any subscriber
```

Three problems this solves:

| Problem | Without | With |
|---------|---------|------|
| **Unchecked kernel changes** | Agent can propose `l0_interface` changes with no review | Gate blocks until HITL + all-agents test + next binary |
| **Over-blocking low-risk changes** | Either nothing is gated or everything is | `brick:sandboxed` auto-approves — no human needed for a forged tool |
| **No audit trail** | Changes happen out-of-band | Every proposal is a typed record; watch() streams lifecycle events |

---

## Layer Position

```
L0  @koi/core
    └── ProposalGate              ← interface only (this doc)
        ProposalInput             ← what the agent provides
        Proposal                  ← the full governance record
        ProposalResult            ← Result<Proposal, KoiError>
        ProposalEvent             ← submitted | reviewed | expired | superseded
        ProposalUnsubscribe       ← () => void (from watch)
        ReviewDecision            ← approved | rejected (with reason)
        ChangeTarget              ← 8-value union (architectural layer)
        ChangeKind                ← create | update | promote | delete | configure | extend
        ProposalStatus            ← pending | approved | rejected | superseded | expired
        GateRequirement           ← requiresHitl, requiresFullTest, takeEffectOn, sandboxTestScope
        ProposalId                ← branded string
        ALL_CHANGE_TARGETS        ← readonly ChangeTarget[] for exhaustiveness checks
        PROPOSAL_GATE_REQUIREMENTS ← frozen Record<ChangeTarget, GateRequirement>

L2  @koi/proposal-memory (future)
    └── implements ProposalGate
    └── in-memory map, sync, dev/test

L2  @koi/proposal-service (future)
    └── implements ProposalGate
    └── HTTP-backed, async, production
    └── integrates with HITL approval UIs
```

`@koi/core` has zero dependencies. `ProposalGate` imports only from `./ecs.js`, `./brick-snapshot.js`, `./common.js`, and `./errors.js` — no vendor types, no framework concepts.

---

## Architecture

### The contract surface

```
ProposalGate
│
├── submit(input)     required — agent submits a change request
├── review(id, dec)   required — human (or automation) records approval/rejection
└── watch(handler)    required — subscribe to proposal lifecycle events
                                 returns ProposalUnsubscribe: () => void
```

All methods return `T | Promise<T>` — in-memory gates return sync values; HTTP-backed gates return Promises. Callers always `await`.

### Blast radius ladder

The key insight: `PROPOSAL_GATE_REQUIREMENTS` is a pure frozen data constant that codifies the "Trust Gate by Layer" table from the architecture doc. Zero logic — just a lookup.

```
ChangeTarget      requiresHitl  requiresFullTest  takeEffectOn    sandboxTestScope
────────────      ────────────  ────────────────  ────────────    ────────────────

brick:sandboxed   false         false             immediately     brick_only
bundle_l2         false         false             immediately     brick_only
brick:promoted    true          false             next_session    brick_plus_integration
sandbox_policy    true          false             config_push     meta_sandbox
gateway_routing   true          false             config_push     staging_gateway
l1_extension      true          true              next_startup    full_agent_test
l1_core           true          true              next_binary     full_agent_test
l0_interface      true          true              next_binary     all_agents_test
                  ▲                                               ▲
                  └── blast radius increases top → bottom        ┘
```

`ChangeTarget` names align with `TrustTier` vocabulary — agents already know `"sandbox"` and `"promoted"` from the ECS layer:

- `"brick:sandboxed"` — tool or skill (TrustTier `"sandbox"`), auto-verified
- `"brick:promoted"` — middleware or channel (TrustTier `"promoted"`), HITL required

### Proposal lifecycle

```
submit(input)
    │
    ▼
Proposal { status: "pending" }
    │
    ├──► watch() handler: proposal:submitted event
    │
    ├── auto-approve path (requiresHitl: false)
    │       │
    │       ▼
    │   Proposal { status: "approved" }
    │       └──► watch() handler: proposal:reviewed event
    │
    ├── HITL path (requiresHitl: true)
    │       │
    │       ▼
    │   [human reviews in UI / approval system]
    │       │
    │       ▼
    │   review(id, { kind: "approved" | "rejected", reason? })
    │       │
    │       ▼
    │   Proposal { status: "approved" | "rejected" }
    │       └──► watch() handler: proposal:reviewed event
    │
    ├── superseded (newer proposal replaces this one)
    │       │
    │       ▼
    │   Proposal { status: "superseded", supersededBy: ProposalId }
    │       └──► watch() handler: proposal:superseded event
    │
    └── expired (expiresAt timestamp passed before review)
            │
            ▼
        Proposal { status: "expired" }
            └──► watch() handler: proposal:expired event
```

Terminal states: `approved`, `rejected`, `superseded`, `expired`. `review()` is a no-op on terminal proposals.

### ProposalInput vs Proposal

```
ProposalInput (what the agent provides):    Proposal (what the gate assigns and returns):

{                                            {
  submittedBy: AgentId                         id: ProposalId         ← gate-assigned
  changeTarget: ChangeTarget                   submittedBy: AgentId
  changeKind: ChangeKind                       changeTarget: ChangeTarget
  description: string                          changeKind: ChangeKind
  brickRef?: BrickRef          ──────────►     description: string
  expiresAt?: number                           brickRef?: BrickRef
  metadata?: JsonObject                        status: ProposalStatus  ← gate-assigned
}                                              submittedAt: number     ← gate-assigned
                                               expiresAt?: number
                                               reviewedAt?: number     ← set on review
                                               reviewDecision?: ReviewDecision
                                               supersededBy?: ProposalId
                                               metadata?: JsonObject
                                             }
```

### ReviewDecision

```typescript
// Approval: reason is optional
const approve: ReviewDecision = { kind: "approved" };
const approveWithNote: ReviewDecision = { kind: "approved", reason: "LGTM" };

// Rejection: reason is required — gate must record why
const reject: ReviewDecision = { kind: "rejected", reason: "introduces sandbox bypass" };
```

Rejection always requires a reason. The distinction from `ApprovalDecision` in `middleware.ts` is intentional — `ReviewDecision` is for persistent structural changes (cross-session); `ApprovalDecision` is for per-tool-call approval (in-turn).

---

## Data Flow

### Agent proposes a low-blast-radius change

```
Agent (e2e-proposal-gate.test.ts)
    │
    │  gate.submit({
    │    submittedBy: agentId("agent-1"),
    │    changeTarget: "brick:sandboxed",
    │    changeKind: "create",
    │    description: "forge calculator tool",
    │  })
    │
    ▼
ProposalGate implementation
    │
    ├── assigns id, submittedAt, status: "pending"
    ├── PROPOSAL_GATE_REQUIREMENTS["brick:sandboxed"]
    │     → requiresHitl: false
    │     → auto-approve immediately
    │
    ├── transitions to status: "approved"
    │
    ├── fires watch handlers:
    │     proposal:submitted { proposal }
    │     proposal:reviewed  { proposalId, decision: { kind: "approved" } }
    │
    └── returns { ok: true, value: Proposal { status: "approved" } }
```

### Agent proposes a high-blast-radius change (HITL path)

```
Agent
    │
    │  gate.submit({
    │    changeTarget: "l0_interface",
    │    changeKind: "extend",
    │    description: "add dispose() to EngineAdapter",
    │  })
    │
    ▼
ProposalGate
    │
    ├── assigns id, submittedAt, status: "pending"
    ├── PROPOSAL_GATE_REQUIREMENTS["l0_interface"]
    │     → requiresHitl: true
    │     → requiresFullTest: true
    │     → takeEffectOn: "next_binary"
    │     → sandboxTestScope: "all_agents_test"
    │
    ├── proposal stays pending — no auto-approval
    │
    └── fires watch: proposal:submitted { proposal }


[later, human reviews in UI]
    │
    │  gate.review(proposalId, { kind: "approved", reason: "backward-compatible" })
    │
    ▼
ProposalGate
    │
    ├── transitions to status: "approved"
    ├── sets reviewedAt, reviewDecision
    └── fires watch: proposal:reviewed { proposalId, decision }
```

### Wired through the full L1 runtime (ComponentProvider + middleware)

```
createKoi({
  manifest: { ... },
  adapter: createLoopAdapter({ modelCall }),
  middleware: [observerMiddleware],          ← wrapToolCall fires for "propose_change"
  providers: [toolProvider],                ← attaches gate + propose_change tool
})
    │
    ▼
Agent turn:
  "Propose creating a new sandboxed calculator tool"
    │
    ▼
Loop: model call (Phase 1: deterministic injection of propose_change tool call)
    │
    ▼
wrapToolCall middleware intercepts "propose_change"
    │
    ▼
propose_change tool executes → gate.submit({ changeTarget: "brick:sandboxed", ... })
    │
    ▼
auto-approved → { ok: true, value: Proposal { status: "approved" } }
    │
    ▼
Loop: model call (Phase 2: real Anthropic summarizes result)
    │
    ▼
done { stopReason: "completed" }
```

---

## ProposalGate Interface

```typescript
interface ProposalGate {
  readonly submit: (input: ProposalInput) => ProposalResult | Promise<ProposalResult>;
  readonly review: (id: ProposalId, decision: ReviewDecision) => void | Promise<void>;
  readonly watch:  (handler: (event: ProposalEvent) => void | Promise<void>) => ProposalUnsubscribe;
}
```

`submit` and `review` follow the `T | Promise<T>` pattern — implementations backed by I/O return Promises; callers always `await`. `watch` is always sync (returns unsubscribe immediately); the handler may be async but the gate does not await it.

---

## Comparison: OpenClaw / NanoClaw vs Koi

| Dimension | NanoClaw | OpenClaw (RFC #26348) | Koi ProposalGate |
|-----------|----------|-----------------------|------------------|
| Scope | Infrastructure (containers) | Generic risk tiers T0–T3 for tool calls | **Layer-aware: 8 ChangeTarget values** |
| Blast-radius awareness | No | Partial (T0–T3 tiers) | **Full: requirements scale per architectural layer** |
| Typed as L0 contract | No | No (unmerged RFC) | **Yes — zero-dep, swappable implementation** |
| HITL for kernel changes | No | Not specified | **Yes — l0_interface always requires HITL** |
| Auto-approve low-risk | No | Not specified | **Yes — brick:sandboxed auto-approves immediately** |
| Event stream | No | No | **Yes — watch() delivers 4 lifecycle events** |
| Supersession | No | No | **Yes — supersededBy links proposals** |
| Expiry | No | No | **Yes — expiresAt optional on ProposalInput** |

Key differentiator: Koi's gate is **layer-aware** — the same interface enforces different requirements depending on which architectural layer is targeted. OpenClaw's RFC #26348 proposes generic risk tiers (T0–T3) without coupling to layer semantics; NanoClaw has no proposal mechanism at all.

---

## API Reference

### Types

| Export | Kind | Description |
|--------|------|-------------|
| `ProposalGate` | interface | The main contract — implement this |
| `ProposalInput` | interface | Agent-provided input to `submit()` |
| `Proposal` | interface | Full governance record returned by gate |
| `ProposalResult` | type | `Result<Proposal, KoiError>` |
| `ProposalEvent` | type | Discriminated union of 4 lifecycle events |
| `ProposalUnsubscribe` | type | `() => void` — call to stop watching |
| `ReviewDecision` | type | `{ kind: "approved"; reason? } \| { kind: "rejected"; reason: string }` |
| `GateRequirement` | interface | Per-layer requirements (HITL, test scope, effect timing) |
| `ChangeTarget` | type | 8-value union of architectural layers |
| `ChangeKind` | type | `"create" \| "update" \| "promote" \| "delete" \| "configure" \| "extend"` |
| `ProposalStatus` | type | `"pending" \| "approved" \| "rejected" \| "superseded" \| "expired"` |
| `ProposalId` | type | Branded string — prevents mixing with other IDs |

### Runtime values

| Export | Type | Value |
|--------|------|-------|
| `proposalId` | `(raw: string) => ProposalId` | Branded constructor |
| `ALL_CHANGE_TARGETS` | `readonly ChangeTarget[]` | All 8 targets — use in exhaustiveness checks |
| `PROPOSAL_GATE_REQUIREMENTS` | `Readonly<Record<ChangeTarget, GateRequirement>>` | Frozen blast-radius table |

### ProposalGate methods

| Method | Required | Signature |
|--------|----------|-----------|
| `submit` | yes | `(input: ProposalInput) → ProposalResult \| Promise<ProposalResult>` |
| `review` | yes | `(id: ProposalId, decision: ReviewDecision) → void \| Promise<void>` |
| `watch` | yes | `(handler: (event: ProposalEvent) → void \| Promise<void>) → ProposalUnsubscribe` |

---

## Implementing a Gate

Minimal conforming implementation (synchronous, in-memory):

```typescript
import type {
  Proposal, ProposalEvent, ProposalGate, ProposalInput,
  ProposalResult, ProposalUnsubscribe, ReviewDecision,
} from "@koi/core";
import { proposalId, PROPOSAL_GATE_REQUIREMENTS } from "@koi/core";

export function createInMemoryProposalGate(): ProposalGate {
  const proposals = new Map<string, Proposal>();
  const handlers = new Set<(event: ProposalEvent) => void | Promise<void>>();
  let seq = 0;

  const emit = (event: ProposalEvent): void => {
    for (const h of handlers) void h(event);
  };

  return {
    submit: (input: ProposalInput): ProposalResult => {
      const id = proposalId(`prop-${++seq}`);
      const req = PROPOSAL_GATE_REQUIREMENTS[input.changeTarget];
      const base: Proposal = {
        id,
        submittedBy: input.submittedBy,
        changeTarget: input.changeTarget,
        changeKind: input.changeKind,
        description: input.description,
        brickRef: input.brickRef,
        status: "pending",
        submittedAt: Date.now(),
        expiresAt: input.expiresAt,
        metadata: input.metadata,
      };

      let proposal = base;
      emit({ kind: "proposal:submitted", proposal });

      if (!req.requiresHitl) {
        // Auto-approve: no human needed
        const decision: ReviewDecision = { kind: "approved" };
        proposal = { ...base, status: "approved", reviewedAt: Date.now(), reviewDecision: decision };
        emit({ kind: "proposal:reviewed", proposalId: id, decision });
      }

      proposals.set(id, proposal);
      return { ok: true, value: proposal };
    },

    review: (id, decision) => {
      const p = proposals.get(id);
      if (!p || p.status !== "pending") return; // no-op on terminal
      const updated: Proposal = { ...p, status: decision.kind, reviewedAt: Date.now(), reviewDecision: decision };
      proposals.set(id, updated);
      emit({ kind: "proposal:reviewed", proposalId: id, decision });
    },

    watch: (handler): ProposalUnsubscribe => {
      handlers.add(handler);
      return () => { handlers.delete(handler); };
    },
  };
}
```

Key implementation rules:

1. **`submit` assigns `id`, `submittedAt`, and initial `status: "pending"`** — never trust agent-provided values for these fields
2. **`review` is a no-op on terminal proposals** (`approved`, `rejected`, `superseded`, `expired`) — idempotent
3. **Consult `PROPOSAL_GATE_REQUIREMENTS` for auto-approve logic** — never hardcode `requiresHitl` checks
4. **`watch` returns an unsubscribe function** — callers must call it to prevent memory leaks
5. **`submit` returns `Result<Proposal, KoiError>`** — validation failures return `{ ok: false, error }`, not throws

---

## Testing

### Core contract tests (no LLM, always run)

```bash
bun test packages/core/src/proposal.test.ts
```

33 tests covering: `proposalId()` factory, `ALL_CHANGE_TARGETS` exhaustiveness, `PROPOSAL_GATE_REQUIREMENTS` immutability + key invariants, `ReviewDecision` variants, `ProposalStatus` all 5 states, `ProposalEvent` all 4 kinds, `Proposal` and `ProposalInput` shapes, `ProposalGate` interface structural conformance. `proposal.ts` achieves 100% line and function coverage.

### Full @koi/core suite

```bash
bun test --cwd packages/core
```

400 tests, 18 files — regression guard ensuring no cross-contract type breakage.

### E2E tests (real Anthropic API, gated on `E2E_TESTS=1`)

```bash
E2E_TESTS=1 bun test tests/e2e/e2e-proposal-gate.test.ts
```

22 tests, 5 sections:

| Section | Tests | What it proves |
|---------|-------|----------------|
| Contract (in-memory gate) | 15 | All interface methods, status transitions, HITL gating, supersession, watch events, expiry |
| L1 smoke | 1 | `createKoi + createLoopAdapter + Anthropic` completes |
| `brick:sandboxed` via runtime | 1 | `propose_change` tool wired through `ComponentProvider`; middleware `wrapToolCall` fires; auto-approved |
| `brick:promoted` HITL enforcement | 1 | Proposal stays `"pending"` through runtime; `gate.review()` transitions to `"approved"` |
| Runtime gate requirements | 4 | All 8 `ChangeTarget` values; blast-radius ordering; watch delivers events for each |

---

## Future

```
@koi/core (L0)
└── ProposalGate ← this contract

@koi/proposal-memory (L2, planned)
└── in-memory Map implementation
└── sync, zero async overhead
└── use for: dev, test, single-node

@koi/proposal-service (L2, planned)
└── HTTP-backed implementation
└── async — delegates to approval service
└── integrates with HITL UI (Slack, web dashboard)
└── use for: production, multi-node, audit-grade logging
```

Consumers code against `ProposalGate` — switching from `@koi/proposal-memory` to `@koi/proposal-service` is a one-line change at the composition root. Neither the agent nor the middleware needs to know which backend is active.
