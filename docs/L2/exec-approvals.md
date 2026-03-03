# @koi/exec-approvals — Progressive Command Allowlisting with Agent-to-Agent Routing

Intercepts tool calls with allow/deny/ask patterns. Approval decisions accumulate progressively across the session. When a child agent hits an "ask" rule, the request is automatically routed to the parent agent via IPC — no human prompt needed unless the parent also escalates.

---

## Why It Exists

1. **Not all tool calls are equal.** `read_file` might be fine, but `rm -rf /` needs a gate. Pattern-based rules sort tool calls into allow (proceed), deny (block), and ask (needs approval) tiers.

2. **Approval fatigue is real.** Approving the same command 50 times per session is pointless. Progressive decisions (`allow_session`, `allow_always`, `deny_always`) let approvals accumulate — each decision reduces future prompts.

3. **Multi-agent systems need agent-to-agent approval.** When a parent spawns a child with attenuated permissions, the child may hit an "ask" rule. Routing to a human every time breaks autonomy. The parent agent can evaluate the request against its own rules and auto-approve — only escalating to a human when its own rules say "ask".

4. **Security boundaries require validation.** IPC messages between agents are untrusted input. Zod schemas validate every payload at the boundary, and the system fails closed (deny by default) on any error.

---

## What This Enables

### Before: Human-only approval

```
Child agent → ask rule fires → human prompt → wait for response → continue
                                   ^
                                   └── BLOCKS EVERYTHING, even for "obviously safe" calls
```

### After: Agent-to-agent escalation chain

```
Child agent → ask rule fires → IPC to Parent
                                    │
                                    ├── Parent's allow list → auto-approve (instant)
                                    ├── Parent's deny list  → auto-deny (instant)
                                    └── Parent's ask list   → escalate to human (HITL)
                                         │
                                         └── No human configured? → deny (fail-safe)
```

### Zero-config auto-wiring (via governance)

```typescript
import { createGovernanceStack } from "@koi/governance";

// That's it. No agentId, parentId, or mailbox fields needed.
// The governance stack auto-discovers them during agent assembly.
const { middlewares, providers } = createGovernanceStack({
  execApprovals: {
    rules: { allow: ["read_*"], deny: ["rm"], ask: ["write_*", "bash:*"] },
    // onAsk is optional — auto-wired when parent + mailbox are available
  },
});
```

During `createKoi()` assembly, the approval routing ComponentProvider discovers:
- `agentId` from `agent.pid.id` (always available)
- `parentId` from `agent.pid.parent` (present for child agents)
- `mailbox` from `agent.component(MAILBOX)` (present when IPC is configured)

If parentId + mailbox are found → child-side handler wired automatically.
If mailbox is found → parent-side listener wired automatically.

---

## Architecture

### Layer

`@koi/exec-approvals` is an **L2 feature package**. It imports only from `@koi/core` (L0) and L0u utilities (`@koi/errors`, `@koi/validation`).

### Module Map

```
src/
├── config.ts                     ExecApprovalsConfig interface + validation
├── evaluate.ts                   Pure 6-step evaluation function (security invariant)
├── middleware.ts                  KoiMiddleware: intercepts tool calls, applies rules
├── pattern.ts                    Compound pattern matching (tool:command)
├── store.ts                      In-memory rules store for progressive decisions
├── types.ts                      ExecApprovalRequest, ProgressiveDecision, ExecRulesStore
│
├── agent-approval-handler.ts     Child-side: routes ask → parent via IPC
├── parent-approval-handler.ts    Parent-side: evaluates child requests, responds
├── ipc-types.ts                  Wire format + Zod schemas for IPC payloads
│
├── index.ts                      Public exports
├── config.test.ts                Config validation tests
├── evaluate.test.ts              Pure evaluation function tests
├── agent-approval-handler.test.ts  Child-side handler tests (happy + 8 failure modes)
├── parent-approval-handler.test.ts Parent-side handler tests
└── __tests__/
    ├── approval-chain.test.ts    Integration: full child→parent→HITL chain
    └── api-surface.test.ts       API surface snapshot
```

### Evaluation Flow (security invariant)

The 6-step evaluation order must not be reordered — it is a security invariant:

```
Tool call arrives
  │
  ├─ 1. base deny    → ABSOLUTE block (cannot be overridden)
  ├─ 2. session deny → accumulated deny_always decisions
  ├─ 3. session allow → accumulated allow_session / allow_always
  ├─ 4. base allow   → static allow list
  ├─ 5. base ask     → trigger onAsk handler
  └─ 6. default deny → no rule matched → block
```

### Agent-to-Agent IPC Flow

```
Child Agent                         Parent Agent
    │                                    │
    │  tool call hits "ask" rule         │
    │                                    │
    │── ExecApprovalIpcPayload ────────► │
    │   (via mailbox.send)               │
    │   {                                │  1. O(1) type check (skip non-matching)
    │     toolId, input,                 │  2. TTL check (skip expired)
    │     matchedPattern,                │  3. Zod validate payload
    │     childAgentId,                  │  4. evaluateToolRequest() with parent rules
    │     riskAnalysis?                  │  5. Map result to IPC response
    │   }                                │
    │                                    │
    │◄── ExecApprovalIpcResponse ────────│
    │   (via mailbox response)           │
    │   {                                │
    │     decision: {                    │
    │       kind: "allow_once" | ...     │
    │       pattern?, reason?            │
    │     }                              │
    │   }                                │
    │                                    │
    │  map to ProgressiveDecision        │
    │  continue tool call                │
```

---

## Core Concepts

### Progressive Decisions

When a tool call hits an "ask" rule, the approval handler returns one of 5 decisions:

| Decision | Effect | Persistence |
|----------|--------|-------------|
| `allow_once` | Proceed this call | None |
| `allow_session` | Proceed + add pattern to session allow list | Session |
| `allow_always` | Proceed + persist pattern to store | Durable |
| `deny_once` | Block this call | None |
| `deny_always` | Block + persist pattern to store | Durable |

Session decisions reduce future prompts — `allow_session("bash:git *")` means all `git` subcommands pass without asking for the rest of the session.

### Compound Patterns

Patterns can match tool ID alone or tool ID + command:

| Pattern | Matches |
|---------|---------|
| `read_file` | Any `read_file` call |
| `bash:git *` | `bash` tool when command starts with `git ` |
| `write_file:/src/**` | `write_file` on paths under `/src/` |
| `*` | Everything (wildcard) |

### Fail-Safe Behavior

The system fails closed at every level:
- No matching rule → deny
- No `onAsk` configured → deny
- IPC timeout → fallback (HITL or deny)
- Malformed IPC response → fallback (HITL or deny)
- Expired TTL → message ignored (no response)
- Unparseable date in TTL check → treated as expired

---

## API Reference

### Factory Functions

**`createExecApprovalsMiddleware(config)`** — Creates the KoiMiddleware (priority 100).

**`createAgentApprovalHandler(config)`** — Creates a child-side onAsk handler that routes to a parent via mailbox.

**`createParentApprovalHandler(config)`** — Creates a parent-side listener that evaluates incoming requests. Returns `Disposable`.

**`evaluateToolRequest(toolId, input, config)`** — Pure evaluation function. Reusable for both middleware and parent-side handler.

### Constants

| Constant | Value | Description |
|----------|-------|-------------|
| `DEFAULT_APPROVAL_TIMEOUT_MS` | `30_000` | Default timeout for IPC + HITL |
| `EXEC_APPROVAL_REQUEST_TYPE` | `"exec-approval-request"` | IPC message type discriminator |

### Types

```typescript
interface ExecApprovalsConfig {
  rules: { allow: string[]; deny: string[]; ask: string[] };
  onAsk?: (req: ExecApprovalRequest) => Promise<ProgressiveDecision>;
  store?: ExecRulesStore;
  approvalTimeoutMs?: number;
  extractCommand?: (input: JsonObject) => string;
  securityAnalyzer?: SecurityAnalyzer;
}

interface AgentApprovalHandlerConfig {
  parentId: AgentId;
  childAgentId: AgentId;
  mailbox: MailboxComponent;
  timeoutMs?: number;
  fallback?: (req: ExecApprovalRequest) => Promise<ProgressiveDecision>;
}

interface ParentApprovalHandlerConfig {
  agentId: AgentId;
  mailbox: MailboxComponent;
  rules: { allow: string[]; deny: string[]; ask: string[] };
  extractCommand?: (input: JsonObject) => string;
  onAsk?: (req: ExecApprovalRequest) => Promise<ProgressiveDecision>;
  sessionState?: { extraAllow: string[]; extraDeny: string[] };
}

type EvaluationResult =
  | { kind: "allow" }
  | { kind: "deny"; reason: string }
  | { kind: "ask"; matchedPattern: string };
```

---

## Examples

### Example 1: Standalone middleware (no agent routing)

```typescript
import { createExecApprovalsMiddleware } from "@koi/exec-approvals";

const middleware = createExecApprovalsMiddleware({
  rules: {
    allow: ["read_file", "list_directory"],
    deny: ["bash:rm *", "bash:sudo *"],
    ask: ["write_file", "bash:*"],
  },
  onAsk: async (req) => {
    // Prompt the human
    const answer = await promptUser(`Allow ${req.toolId}?`);
    return answer ? { kind: "allow_once" } : { kind: "deny_once", reason: "User denied" };
  },
});
```

### Example 2: Governance auto-wiring (recommended)

```typescript
import { createGovernanceStack } from "@koi/governance";

const { middlewares, providers } = createGovernanceStack({
  execApprovals: {
    rules: {
      allow: ["read_*", "search_*"],
      deny: ["bash:rm *"],
      ask: ["write_*", "bash:*"],
    },
    // No onAsk needed — auto-wired when parent agent is available.
    // Falls back to deny if no parent and no onAsk.
  },
});

// Pass to createKoi:
const runtime = await createKoi({
  middleware: middlewares,
  providers,
  // ...
});
```

### Example 3: Manual agent routing (advanced)

```typescript
import {
  createAgentApprovalHandler,
  createParentApprovalHandler,
} from "@koi/exec-approvals";

// Child-side: route "ask" decisions to parent
const childOnAsk = createAgentApprovalHandler({
  parentId: parentAgent.pid.id,
  childAgentId: childAgent.pid.id,
  mailbox: childMailbox,
  timeoutMs: 15_000,
  fallback: async (req) => promptHuman(req), // HITL as fallback
});

// Parent-side: evaluate incoming child requests
const parentHandler = createParentApprovalHandler({
  agentId: parentAgent.pid.id,
  mailbox: parentMailbox,
  rules: { allow: ["read_*"], deny: ["rm"], ask: ["write_*"] },
  onAsk: async (req) => promptHuman(req), // parent's own HITL
});

// Cleanup when done
parentHandler[Symbol.dispose]();
```

---

## Performance Properties

| Operation | Cost | Notes |
|-----------|------|-------|
| Message type check | O(1) | String comparison before any validation |
| TTL expiry check | O(1) | Single Date.now() comparison |
| Zod payload validation | O(n) | Only runs after O(1) type check passes |
| Pattern matching | O(p) | p = number of patterns in the matched tier |
| Handler lookup | O(1) | Map.get() in per-agent handler map |
| ComponentProvider attach | Once | Runs only during agent assembly |

---

## Layer Compliance

```
L0  @koi/core ──────────────────────────────┐
    AgentId, AgentMessage, MailboxComponent,  │
    JsonObject, KoiError, Result              │
                                              │
L0u @koi/errors ────────────────────────────┤
    KoiRuntimeError                           │
                                              │
L0u @koi/validation ────────────────────────┤
    validateWith (Zod wrapper)                │
                                              │
ext zod ────────────────────────────────────┤
    IPC boundary schema validation            │
                                             ▼
L2  @koi/exec-approvals ◄──────────────────┘
    imports from L0 + L0u only
    NO imports from @koi/engine or L2 peers
```

---

## Testing

- **160 tests** across 10 files (+ 3 skipped E2E tests)
- **Coverage**: >80% lines, functions, and statements
- Key test files:
  - `evaluate.test.ts` — Pure evaluation function, all 6 steps
  - `agent-approval-handler.test.ts` — Happy paths (5 decision variants) + 8 failure modes (timeout, send failure, malformed, escalation, no fallback)
  - `parent-approval-handler.test.ts` — Allow/deny/ask routing, TTL expiry, malformed payload, dispose cleanup
  - `__tests__/approval-chain.test.ts` — Full child→parent→HITL integration chain

---

## References

- Issue: [#752](https://github.com/windoliver/koi/issues/752)
- `@koi/core` — L0 types: `AgentMessage`, `MailboxComponent`, `AgentId`
- `@koi/governance` — L3 governance stack auto-wiring
- `@koi/delegation` — Agent-to-agent permission delegation (complementary feature)
- Tests: `packages/exec-approvals/src/` (colocated) + `packages/exec-approvals/src/__tests__/`
