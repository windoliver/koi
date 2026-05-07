# @koi/ipc-nexus

**Layer:** L2  
**Package:** `packages/lib/ipc-nexus`

`@koi/ipc-nexus` provides a Nexus-backed `MailboxComponent` for cross-node agent messaging.

This v2 implementation is intentionally small and transport-centered:

- it builds on `NexusTransport` from `@koi/nexus-client`
- it implements the `MailboxComponent` contract from `@koi/core`
- it uses polling for inbox delivery in the first pass
- it supports explicit fallback to another `MailboxComponent` when Nexus is unavailable

## API

```typescript
import { agentId } from "@koi/core";
import { createHttpTransport } from "@koi/nexus-client";
import { createNexusMailbox } from "@koi/ipc-nexus";

const transport = createHttpTransport({
  url: "http://localhost:2026",
});

const mailbox = await createNexusMailbox({
  agentId: agentId("agent-a"),
  transport,
  pollIntervalMs: 1_000,
  pageSize: 50,
});
```

### `NexusMailboxConfig`

```typescript
interface NexusMailboxConfig {
  readonly agentId: AgentId;
  readonly transport: NexusTransport;
  readonly fallback?: MailboxComponent | undefined;
  readonly inboxMethodPrefix?: string | undefined;
  readonly pollIntervalMs?: number | undefined;
  readonly pageSize?: number | undefined;
}
```

## Behavior

- `send(message)` sends an `AgentMessageInput` through Nexus RPC and returns a fully populated `AgentMessage`
- `list(filter)` lists inbox messages for the configured agent and applies the standard `MessageFilter`
- `onMessage(handler)` starts polling and dispatches unseen messages to subscribers
- `drain()` returns the locally seen message buffer and clears it

## Fallback

Fallback is explicit and injected through `config.fallback`.

- if `transport.health()` fails during creation and a fallback exists, `createNexusMailbox()` returns the fallback mailbox
- if startup health passes but a later `send()` or `list()` call fails, the mailbox degrades to the fallback for subsequent operations
- if no fallback is configured, Nexus errors surface through the normal `MailboxComponent` return path

## Design Notes

- This first v2 slice does **not** restore the archive-era SSE delivery path
- The RPC method names are isolated behind a small client module so transport mapping can evolve without changing callers
- The package focuses on contract parity with `MailboxComponent`, not on full v1 feature parity
