# @koi/ipc-local — In-Process Mailbox IPC

Implements the `MailboxComponent` (L0) contract using in-memory storage with microtask-based subscriber dispatch. Also provides `MailboxRouter` for in-process multi-agent message routing with routing-token authentication.

---

## Why It Exists

Multi-agent Koi graphs need a way for agents to send messages to one another within the same process. This package provides:

- A `MailboxComponent` implementation backed by in-memory storage (no network, no serialization)
- Microtask dispatch so subscribers fire asynchronously but in the same event-loop tick
- A `MailboxRouter` that authenticates cross-agent delivery without exposing full mailbox access
- FIFO eviction with configurable `maxMessages` cap and `RESOURCE_EXHAUSTED` errors on overflow

---

## Public API

```typescript
import { createLocalMailbox, createLocalMailboxRouter } from "@koi/ipc-local";

// Single-agent (no router)
const mailbox = createLocalMailbox({ agentId: agentId("bot") });
await mailbox.send({ from: agentId("bot"), to: agentId("bot"), kind: "event", type: "ping", payload: {} });
const messages = mailbox.list();

// Multi-agent with router
const router = createLocalMailboxRouter();
const alice = createLocalMailbox({ agentId: agentId("alice"), router });
const bob   = createLocalMailbox({ agentId: agentId("bob"),   router });
router.register(agentId("alice"), alice);
router.register(agentId("bob"),   bob);

// alice sends to bob — router delivers via authenticated delivery function
await alice.send({ from: agentId("alice"), to: agentId("bob"), kind: "event", type: "hello", payload: {} });

// Read bob's inbox via a read-only view (no drain/close/send exposed)
const view = router.getView(agentId("bob"));
const msgs = await view?.list();

// Subscribe
const unsub = bob.onMessage((msg) => console.log(msg.type));
unsub(); // remove subscriber

// Lifecycle
const drained = alice.drain(); // returns all messages and clears inbox
alice.close();                 // stops dispatch; subsequent send() rejects
```

---

## Security Model

- **Routing-token authentication**: `send()` stamps a one-shot `routedInputs` WeakSet token on routed messages. The delivery function verifies the token before injecting into the recipient's inbox — forged-sender messages without a valid token are rejected.
- **Read-only router views**: `router.getView()` returns a `MailboxView` that exposes only `list()` and `revoked`. `send()`, `drain()`, `close()`, and `onMessage()` are absent at both compile time and runtime — callers with a router reference cannot drain or inject into another agent's inbox.
- **Module-private WeakMaps**: delivery functions, routing tokens, and router registrations are stored in module-private WeakMaps inaccessible via reflection or prototype traversal.
- **View revocation**: old views are revoked on `unregister()` or re-registration. `view.revoked` becomes `true` and `list()` returns `[]` predictably.

---

## Configuration

```typescript
interface LocalMailboxConfig {
  readonly agentId: AgentId;
  readonly maxMessages?: number;  // default 10_000; must be >= 1
  readonly router?: MailboxRouter; // required for router.register()
  readonly onError?: (error: unknown, message: AgentMessage) => void;
}
```

`maxMessages` enforces FIFO eviction: once the inbox is full, `send()` rejects with a `RESOURCE_EXHAUSTED` error before accepting further messages.

---

## Layer & Dependencies

- **Layer**: L2
- **Imports from**: `@koi/core` (L0) only
- **Runtime dependency**: Bun (uses microtask scheduling via `queueMicrotask`)

---

> **Maintenance note (PR #2046):** Replaced `!` non-null assertions in `mailbox.ts` (delivery function lookup in `send()` — `self!` → explicit `if (self === undefined) throw` guard) and test files (`symbols[0]!`, `router.getView()!` → explicit undefined checks) to comply with `noNonNullAssertion` Biome rule. No functional change.
