# @koi/ipc-nexus — Agent-to-Agent Messaging via Nexus IPC

Agent-to-agent messaging through a central REST mailbox. Any Koi agent can send messages to any other agent — the LLM decides when to communicate using `ipc_send` and `ipc_list` tools.

## Why

Agents working in a swarm need to coordinate — request code reviews, broadcast build results, delegate subtasks. Without IPC, agents are isolated:

```
Agent A ──(works alone)──► done
Agent B ──(works alone)──► done     ← no coordination, duplicated effort
Agent C ──(works alone)──► done
```

With `@koi/ipc-nexus`, agents talk to each other through a shared mailbox:

```
Agent A ──ipc_send("review this")──► Nexus ──► Agent B (reviewer)
Agent B ──ipc_send("approved")─────► Nexus ──► Agent A
Agent A ──ipc_send("deploy")───────► Nexus ──► Agent C (deployer)
```

## Use Cases

### Autonomous CI Pipeline

An orchestrator delegates tasks to specialist agents, aggregates results, and ships — zero human coordination:

```
  Human: "Ship feature X"
         │
         ▼
  ┌──────────────┐
  │ Orchestrator  │  "I'll coordinate the team"
  └──────┬───────┘
         │  Fan-out: 3 ipc_send(kind:"request") calls
         │
    ┌────┴────────────────┬──────────────────────┐
    ▼                     ▼                      ▼
┌──────────┐       ┌────────────┐         ┌────────────┐
│  Coder   │       │ Test Runner│         │ Typechecker │
│  Agent   │       │   Agent    │         │   Agent     │
└────┬─────┘       └─────┬──────┘         └──────┬─────┘
     │                   │                       │
     │ "code ready"      │                       │
     ├──────────────────▶│                       │
     ├───────────────────┼──────────────────────▶│
     │                   │                       │
     │             runs tests               checks types
     │                   │                       │
     │  kind:"response"  │   kind:"response"     │
     │  correlationId=X  │   correlationId=Y     │
     │◀──────────────────┤                       │
     │◀──────────────────┼───────────────────────┤
     │
     │  Orchestrator: ipc_list(kind:"response")
     │  All 3 passed → ipc_send("deploy") to deployer
     ▼
┌──────────┐
│ Deployer │
│  Agent   │──── kind:"response" ────▶ Orchestrator
└──────────┘

  Orchestrator: "Feature X shipped. All checks passed."
```

### Peer Code Review

Two agents collaborate: one writes code, the other reviews it:

```
┌─────────────┐                                     ┌─────────────┐
│  Coder      │                                     │  Reviewer   │
│  Agent      │                                     │  Agent      │
│             │                                     │             │
│ writes code │                                     │  idle...    │
│ ...done     │                                     │             │
│             │── kind:"request"  ──────────────────▶│             │
│             │   type:"code-review"                │  reviews    │
│             │   payload:{ file, diff }            │  the diff   │
│             │                                     │  ...done    │
│             │◀── kind:"response" ─────────────────│             │
│             │    correlationId: <original-id>     │             │
│             │    payload:{ approved: true }        │             │
│  continues  │                                     │             │
└─────────────┘                                     └─────────────┘
```

### Event-Driven Monitoring

Agents broadcast status updates without expecting replies:

```
┌──────────┐   kind:"event"         ┌──────────────┐
│ CI Agent │──type:"build-complete"─▶│ Deploy Agent │
│          │  payload:{ success }    │  (listens)   │
└──────────┘                        └──────┬───────┘
                                           │
     kind:"event"                          │  deploys if success
     type:"deploy-complete"                │
┌──────────────┐◀──────────────────────────┘
│ Notification │
│    Agent     │──── notifies Slack/email
└──────────────┘

  No responses. No correlation IDs. Fire-and-forget.
```

### Multi-Agent Debug Session

An agent hits a bug it can't solve alone — it asks a specialist for help:

```
┌──────────────┐                              ┌──────────────┐
│  Feature     │                              │  Debug       │
│  Agent       │                              │  Specialist  │
│              │                              │              │
│ hits error   │                              │              │
│ ...stuck     │                              │              │
│              │── kind:"request" ───────────▶│              │
│              │   type:"debug-help"          │ analyzes     │
│              │   payload:{ error, stack,    │ the error    │
│              │     file, context }          │ ...found fix │
│              │                              │              │
│              │◀── kind:"response" ──────────│              │
│              │    payload:{ fix, patch }    │              │
│ applies fix  │                              │              │
│ continues    │                              │              │
└──────────────┘                              └──────────────┘
```

## Architecture

```
L0  @koi/core          MailboxComponent + MAILBOX token + AgentMessage types
L2  @koi/ipc-nexus     NexusClient + MailboxAdapter + ComponentProvider + tools
```

The mailbox is an **ECS component** attached to agents via a `ComponentProvider`. The provider also registers `ipc_send` and `ipc_list` as agent-facing tools — the LLM calls them autonomously.

```
┌──────────────────────────────────────────────────────────┐
│                     createKoi()                          │
│   providers: [createIpcNexusProvider({ agentId, ... })]  │
└────────────────────────┬─────────────────────────────────┘
                         │ attach()
                         ▼
                  ┌──────────────┐
                  │   Agent      │
                  │              │
                  │  MAILBOX     │◄── MailboxComponent (send/onMessage/list)
                  │  tool:ipc_send  │◄── LLM-callable tool
                  │  tool:ipc_list  │◄── LLM-callable tool
                  └──────┬───────┘
                         │ HTTP
                         ▼
                  ┌──────────────┐
                  │  Nexus IPC   │  Inbox per agent
                  │  Server      │  REST API v2
                  └──────────────┘
```

## Quick Start

```typescript
import { createKoi } from "@koi/engine";
import { createLoopAdapter } from "@koi/engine-loop";
import { createIpcNexusProvider } from "@koi/ipc-nexus";
import { agentId } from "@koi/core";

// 1. Create provider — attaches MAILBOX + tools
const provider = createIpcNexusProvider({
  agentId: agentId("my-agent"),
  nexusBaseUrl: "http://localhost:2026",
});

// 2. Wire into runtime
const runtime = await createKoi({
  manifest: { name: "my-agent", version: "1.0.0", model: { name: "claude-haiku-4-5-20251001" } },
  adapter: createLoopAdapter({ modelCall: handler, maxTurns: 10 }),
  providers: [provider],
});

// 3. Agent can now send/receive messages via tools
//    LLM sees ipc_send and ipc_list in its tool list
const events = await collectEvents(
  runtime.run({ kind: "text", text: "Send a code review request to reviewer-agent" }),
);
```

The LLM will autonomously call `ipc_send` when it decides to communicate.

## Message Flow

```
  Agent A calls ipc_send tool
         │
         ▼
  ┌─────────────────┐
  │ mapKoiToNexus() │  Koi "request" → Nexus "task"
  │                 │  Koi "response" → Nexus "response"
  │                 │  Koi "event"   → Nexus "event"
  │                 │  Koi "cancel"  → Nexus "cancel"
  └────────┬────────┘
           │
           ▼  POST /api/v2/ipc/send
  ┌─────────────────┐     { from, to, kind, type, payload,
  │  Nexus Server   │       correlationId?, ttlSeconds?,
  │                 │       metadata? }
  │  generates:     │
  │  • UUID id      │     Response: NexusMessageEnvelope
  │  • ISO timestamp│     { id, createdAt, ...request }
  └────────┬────────┘
           │  stored in recipient's inbox
           ▼
  Agent B polls:  GET /api/v2/ipc/inbox/agent-b
           │
  ┌────────┴────────┐
  │ mapNexusToKoi() │  Nexus "task" → Koi "request"
  │ + deduplication │  seen.has(id) → skip
  └────────┬────────┘
           │
           ▼
  handler(AgentMessage) ← Agent B's onMessage() fires
```

## Message Kinds

| Kind | Purpose | Example |
|------|---------|---------|
| `"request"` | Ask another agent to do something | Code review, deploy, run tests |
| `"response"` | Reply to a request (linked by `correlationId`) | Review approved, deploy succeeded |
| `"event"` | Fire-and-forget notification | Build complete, status update |
| `"cancel"` | Cancel a pending request | Abort deployment |

## Patterns

### Request-Response (Correlated)

```typescript
// Agent A sends a request
const result = await mailbox.send({
  from: agentId("agent-a"),
  to: agentId("agent-b"),
  kind: "request",
  type: "code-review",
  payload: { file: "auth.ts", diff: "..." },
});

// Agent B receives and responds with correlationId
mailbox.onMessage(async (msg) => {
  if (msg.kind === "request") {
    await mailbox.send({
      from: agentId("agent-b"),
      to: msg.from,
      kind: "response",
      type: msg.type,
      correlationId: msg.id,  // ← links response to request
      payload: { approved: true },
    });
  }
});
```

### Fan-Out (Orchestrator → Workers)

```
  ┌──────────────┐
  │ Orchestrator  │
  └──────┬───────┘
         │  ipc_send × 3
    ┌────┼────┐
    ▼    ▼    ▼
  ┌───┐┌───┐┌───┐
  │ T ││ L ││ C │   T = test-runner, L = linter, C = typechecker
  └─┬─┘└─┬─┘└─┬─┘
    │    │    │  kind:"response", correlationId
    └────┼────┘
         ▼
  ┌──────────────┐
  │ Orchestrator  │  ipc_list(kind:"response")
  │ aggregates    │  → all 3 passed → ship it
  └──────────────┘
```

### Event Bus (Fire-and-Forget)

```typescript
// CI agent broadcasts build result
await mailbox.send({
  from: agentId("ci-agent"),
  to: agentId("deploy-agent"),
  kind: "event",
  type: "build-complete",
  payload: { success: true, buildId: "abc123" },
  metadata: { source: "ci" },
});
// No response expected — fire and forget
```

## Direct Mailbox Usage

For programmatic use outside the LLM tool loop:

```typescript
import { createNexusMailbox } from "@koi/ipc-nexus";
import { agentId } from "@koi/core";

const mailbox = createNexusMailbox({
  agentId: agentId("my-agent"),
  baseUrl: "http://localhost:2026",
  pollMinMs: 1_000,     // min poll interval (backoff resets on message)
  pollMaxMs: 30_000,    // max poll interval (backoff ceiling)
  pollMultiplier: 2,    // exponential backoff multiplier
  pageLimit: 50,        // messages per poll page
});

// Send
const result = await mailbox.send({
  from: agentId("my-agent"),
  to: agentId("other-agent"),
  kind: "request",
  type: "task",
  payload: { action: "review" },
});
if (!result.ok) console.error(result.error.message);

// Subscribe to incoming messages
const unsubscribe = mailbox.onMessage((msg) => {
  console.log(`Got ${msg.kind} from ${msg.from}: ${msg.type}`);
});

// Query inbox with filters
const requests = await mailbox.list({ kind: "request", from: agentId("boss") });

// Cleanup
unsubscribe();
mailbox[Symbol.dispose]();
```

## Provider Configuration

```typescript
import { createIpcNexusProvider } from "@koi/ipc-nexus";

const provider = createIpcNexusProvider({
  agentId: agentId("my-agent"),        // required — agent's identity
  nexusBaseUrl: "http://localhost:2026", // Nexus server URL
  authToken: "Bearer ...",              // optional auth token
  trustTier: "verified",               // tool trust tier (default: "verified")
  prefix: "ipc",                       // tool name prefix (default: "ipc")
  pollMinMs: 1_000,                    // min poll interval
  pollMaxMs: 30_000,                   // max poll interval
  pageLimit: 50,                       // messages per page
  timeoutMs: 10_000,                   // HTTP timeout
  operations: ["send", "list"],        // which tools to register (default: both)
});
```

| Option | Default | Purpose |
|--------|---------|---------|
| `agentId` | — | Agent identity for inbox routing |
| `nexusBaseUrl` | `http://localhost:2026` | Nexus IPC server URL |
| `authToken` | `undefined` | Bearer token for authenticated Nexus |
| `trustTier` | `"verified"` | Tool trust level |
| `prefix` | `"ipc"` | Tool name prefix → `ipc_send`, `ipc_list` |
| `pollMinMs` | `1000` | Minimum polling interval (ms) |
| `pollMaxMs` | `30000` | Maximum polling interval after backoff |
| `pageLimit` | `50` | Messages fetched per poll cycle |
| `timeoutMs` | `10000` | HTTP request timeout |
| `operations` | `["send", "list"]` | Which tools to expose |

## Nexus REST API

The client targets these 4 endpoints:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/v2/ipc/send` | POST | Send a message to another agent's inbox |
| `/api/v2/ipc/inbox/{agentId}` | GET | List messages in an agent's inbox |
| `/api/v2/ipc/inbox/{agentId}/count` | GET | Count messages in inbox |
| `/api/v2/ipc/provision/{agentId}` | POST | Create an empty inbox (204) |

Query parameters for inbox listing: `limit` (page size), `offset` (pagination).

## Polling & Backoff

The mailbox polls the inbox automatically when `onMessage` handlers are registered:

```
  onMessage() registered
       │
       ▼
  Start polling at pollMinMs (1s)
       │
       ├── messages found → reset to pollMinMs
       │
       └── no messages → interval × pollMultiplier
                          │
                          ▼
                   capped at pollMaxMs (30s)
```

- Polling starts when the first handler is registered
- Polling stops when the last handler is unsubscribed
- Backoff resets immediately when a message arrives
- Each message is delivered exactly once (deduplication via `seen` set)
- Handler errors are swallowed — one broken handler cannot crash the polling loop

## Error Handling

`send()` returns `Result<AgentMessage, KoiError>` — never throws:

| HTTP Status | Error Code | Retryable |
|-------------|-----------|-----------|
| 404 | `NOT_FOUND` | No |
| 429 | `RATE_LIMIT` | Yes |
| 408, 504 | `TIMEOUT` | Yes |
| 500+ | `EXTERNAL` | Yes |
| Network error | `EXTERNAL` | Depends |

```typescript
const result = await mailbox.send(message);
if (!result.ok) {
  if (result.error.retryable) {
    // safe to retry
  }
  console.error(result.error.message);
}
```

## Tools

### `ipc_send`

Sends a message to another agent's mailbox.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `from` | string | yes | Sender agent ID |
| `to` | string | yes | Recipient agent ID |
| `kind` | string | yes | `request`, `response`, `event`, or `cancel` |
| `type` | string | yes | Application-level message type |
| `payload` | object | yes | Message payload |
| `correlationId` | string | no | Links response to originating request |
| `ttlSeconds` | number | no | Time-to-live in seconds |
| `metadata` | object | no | Routing hints, tracing context |

### `ipc_list`

Lists messages in the agent's inbox with optional filtering.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `kind` | string | no | Filter by message kind |
| `type` | string | no | Filter by message type |
| `from` | string | no | Filter by sender |
| `limit` | number | no | Maximum messages to return |

## L0 Types (in @koi/core)

```typescript
// Branded message ID
type MessageId = string & { readonly [__messageBrand]: "MessageId" };

// Message kinds
type MessageKind = "request" | "response" | "event" | "cancel";

// Full message envelope (received)
interface AgentMessage {
  readonly id: MessageId;
  readonly from: AgentId;
  readonly to: AgentId;
  readonly kind: MessageKind;
  readonly correlationId?: MessageId;
  readonly createdAt: string;
  readonly ttlSeconds?: number;
  readonly type: string;
  readonly payload: JsonObject;
  readonly metadata?: JsonObject;
}

// Message input (id + createdAt generated by backend)
type AgentMessageInput = Omit<AgentMessage, "id" | "createdAt">;

// ECS component
interface MailboxComponent {
  readonly send: (message: AgentMessageInput) => Promise<Result<AgentMessage, KoiError>>;
  readonly onMessage: (handler: (message: AgentMessage) => void | Promise<void>) => () => void;
  readonly list: (filter?: MessageFilter) => readonly AgentMessage[] | Promise<readonly AgentMessage[]>;
}

// Well-known token
const MAILBOX: SubsystemToken<MailboxComponent>;
```

## Public API

| Export | Type | Purpose |
|--------|------|---------|
| `createNexusMailbox` | Factory | Creates a `MailboxComponent` backed by Nexus REST |
| `createIpcNexusProvider` | Factory | Creates a `ComponentProvider` (MAILBOX + tools) |
| `createSendTool` | Factory | Creates `ipc_send` tool (advanced usage) |
| `createListTool` | Factory | Creates `ipc_list` tool (advanced usage) |
| `NexusMailboxConfig` | Interface | Config for `createNexusMailbox` |
| `IpcNexusProviderConfig` | Interface | Config for `createIpcNexusProvider` |
| `IpcOperation` | Type | `"send" \| "list"` |
| `DEFAULT_PREFIX` | Const | `"ipc"` |
| `OPERATIONS` | Const | `["send", "list"]` |

## Related

- Issue #192 — Original implementation issue
- Issue #193 — `@koi/registry-nexus` (agent discovery)
- Issue #397 — `@koi/events-nexus` (event sourcing)
- `@koi/core` `mailbox.ts` — L0 types
- `docs/service-provider.md` — `createServiceProvider` pattern used internally
