# @koi/scratchpad-nexus — Group-Scoped Shared File Store via Nexus VFS

`@koi/scratchpad-nexus` is an L2 feature package that provides a shared, versioned
file store for agents within the same group. It implements the process-model equivalent
of shared memory — agents can write, read, list, and delete files in a group-scoped
namespace backed by the Nexus VFS.

---

## Why it exists

Before this package, agents in the same group had no structured way to share data
beyond passing messages through the IPC mailbox. The process model gap analysis
([#630](https://github.com/windoliver/koi/issues/630)) identified this as the
"shared memory equivalent" missing from Koi's process abstraction.

This package:

1. **Provides group-scoped file storage** — each agent group gets an isolated namespace
   on the Nexus VFS, with path-based read/write access
2. **Implements per-file CAS concurrency** — each path carries a generation counter
   for compare-and-swap updates, preventing lost writes
3. **Buffers writes client-side** — a bounded write buffer coalesces writes within a
   turn, flushing on read (consistency) or turn boundary (durability)
4. **Caches reads with generation checks** — LRU cache with lightweight generation
   probes avoids redundant full reads when data hasn't changed
5. **Exposes agent-facing tools** — `scratchpad_write`, `scratchpad_read`,
   `scratchpad_list`, `scratchpad_delete` for LLM tool use

---

## Architecture

### Layer position

```
L2 @koi/scratchpad-nexus
    imports: @koi/core (L0)
    imports: @koi/nexus-client (L0u)
    imports: @koi/test-utils (L0u, devDependency only)
    peer L2 imports: none
```

### Internal module map

```
index.ts                   ← public re-exports
│
├── constants.ts            ← defaults, operation types, buffer/cache limits
├── scratchpad-client.ts    ← thin Nexus RPC wrapper (write, read, generation, list, delete, provision)
├── write-buffer.ts         ← bounded Map<path, BufferedWrite> with flush semantics
├── generation-cache.ts     ← LRU cache with generation-based conditional reads
├── scratchpad-adapter.ts   ← ScratchpadComponent factory (owns buffer + cache)
├── scratchpad-provider.ts  ← ComponentProvider + middleware via createServiceProvider
└── tools/
    ├── write.ts            ← scratchpad_write tool factory
    ├── read.ts             ← scratchpad_read tool factory
    ├── list.ts             ← scratchpad_list tool factory
    └── delete.ts           ← scratchpad_delete tool factory
```

### Data flow

```
Agent tool call: scratchpad_write("notes/plan.md", content)
  │
  ▼
┌────────────────────────┐
│  scratchpad-adapter     │
│  (ScratchpadComponent)  │
│                         │
│  validate path/size     │
│  write → buffer         │ ← buffered locally, last-write-wins within turn
│  flush on read/turn     │
└───────────┬─────────────┘
            │ flush()
            ▼
┌────────────────────────┐
│  scratchpad-client      │
│  (Nexus RPC)            │
│                         │
│  scratchpad.write       │ ← CAS: expectedGeneration → 409 CONFLICT if stale
│  scratchpad.read        │
│  scratchpad.generation  │ ← lightweight probe for cache validation
│  scratchpad.list        │
│  scratchpad.delete      │
└───────────┬─────────────┘
            │
            ▼
       Nexus VFS (server-side storage)
```

---

## API

### `createScratchpadNexusProvider(config)`

Factory that returns a `ComponentProvider` and flush middleware for wiring into an agent.

```typescript
import { createScratchpadNexusProvider } from "@koi/scratchpad-nexus";

const { provider, middleware } = createScratchpadNexusProvider({
  groupId: agentGroupId("team-alpha"),
  nexusClient,
  nexusBaseUrl: "https://nexus.example.com",
});

// Wire into agent assembly
// provider attaches SCRATCHPAD component + tools
// middleware flushes write buffer on turn boundary
```

| Parameter | Type | Default | Description |
|---|---|---|---|
| `groupId` | `AgentGroupId` | required | Group namespace for file isolation |
| `nexusClient` | `NexusClient` | required | Nexus RPC client |
| `nexusBaseUrl` | `string` | `"http://localhost:4100"` | Nexus server URL |
| `prefix` | `string` | `"scratchpad"` | RPC method prefix |
| `bufferSize` | `number` | `100` | Max buffered writes before forced flush |
| `cacheSize` | `number` | `100` | LRU cache capacity for read cache |

**Returns:** `{ provider: ComponentProvider, middleware: KoiMiddleware }`

### `createScratchpadAdapter(config)`

Lower-level factory that creates the `ScratchpadComponent` directly.

```typescript
import { createScratchpadAdapter } from "@koi/scratchpad-nexus";

const scratchpad = createScratchpadAdapter({
  groupId: agentGroupId("team-alpha"),
  client,
  bufferSize: 100,
  cacheSize: 100,
});

const result = await scratchpad.write({
  path: scratchpadPath("notes/plan.md"),
  content: "# Plan\n\nStep 1: ...",
});
```

### `createScratchpadClient(config)`

Thin Nexus RPC wrapper with typed methods.

```typescript
import { createScratchpadClient } from "@koi/scratchpad-nexus";

const client = createScratchpadClient({
  nexusClient,
  prefix: "scratchpad",
});

const entry = await client.read(agentGroupId("team-alpha"), scratchpadPath("notes/plan.md"));
```

---

## Concurrency model

### Per-file CAS (Compare-And-Swap)

Each file path has its own monotonically increasing generation counter:

| `expectedGeneration` value | Behaviour |
|---|---|
| `undefined` | Unconditional write — always succeeds |
| `0` | Create-only — fails with `CONFLICT` if file exists |
| `> 0` | CAS update — fails with `CONFLICT` if server generation differs |

```typescript
// Create-only: fails if file already exists
await scratchpad.write({
  path: scratchpadPath("config.json"),
  content: "{}",
  expectedGeneration: 0,
});

// CAS update: read-modify-write cycle
const entry = await scratchpad.read(scratchpadPath("config.json"));
if (!entry.ok) return;

await scratchpad.write({
  path: scratchpadPath("config.json"),
  content: updatedContent,
  expectedGeneration: entry.value.generation,
});
```

### Write buffer semantics

- `write()` stores to a local bounded `Map<ScratchpadPath, BufferedWrite>`
- Within a turn, only the last write per path is kept (last-write-wins coalescing)
- `read()` and `list()` trigger `flush()` first (consistency guarantee)
- Turn-boundary middleware calls `flush()` after each turn (durability guarantee)
- Buffer has a hard capacity limit (default 100) — forced flush when full

### Generation-based read cache

- LRU cache (default 100 entries) stores full `ScratchpadEntry` keyed by path
- On read: check cache → `scratchpad.generation` RPC (lightweight) → compare
  - Generation matches → serve from cache (zero-cost read)
  - Generation differs → fetch fresh entry and update cache
- Cache miss → full `scratchpad.read` RPC

---

## Agent-facing tools

The package provides four tools that agents can invoke via LLM tool use:

| Tool | Parameters | Description |
|---|---|---|
| `scratchpad_write` | `path`, `content`, `expectedGeneration?`, `ttlSeconds?`, `metadata?` | Write or update a file |
| `scratchpad_read` | `path` | Read a file's content |
| `scratchpad_list` | `glob?`, `authorId?`, `limit?` | List file summaries (no content) |
| `scratchpad_delete` | `path` | Delete a file |

All tools validate inputs at the boundary and return structured `Result` types.

---

## Validation rules

| Rule | Limit | Error code |
|---|---|---|
| Path contains `..` | Rejected | `VALIDATION` |
| Path starts with `/` | Rejected | `VALIDATION` |
| Path length | 256 chars max | `VALIDATION` |
| File content size | 1 MB max | `VALIDATION` |
| Files per group | 1000 max | Server-enforced |

---

## Performance properties

| Operation | Cost | Notes |
|---|---|---|
| Buffered write | ~0 (local Map insert) | No network I/O until flush |
| Cache-hit read | 1 lightweight RPC | `scratchpad.generation` probe (~1ms) |
| Cache-miss read | 1 full RPC | `scratchpad.read` (~5-10ms) |
| List | 1 RPC | `scratchpad.list` (server-filtered) |
| Turn-boundary flush | 1 RPC per dirty path | Coalesced — only final state per path |

Write-heavy workloads benefit from coalescing: 50 writes to the same path within one
turn result in a single `scratchpad.write` RPC at flush time.

---

## Examples

### Basic write and read

```typescript
import { createScratchpadNexusProvider } from "@koi/scratchpad-nexus";
import { agentGroupId, scratchpadPath } from "@koi/core";

const { provider, middleware } = createScratchpadNexusProvider({
  groupId: agentGroupId("team-alpha"),
  nexusClient,
});

// After provider attaches SCRATCHPAD component to agent:
const scratchpad = agent.component(SCRATCHPAD);

await scratchpad.write({
  path: scratchpadPath("shared/notes.md"),
  content: "# Meeting notes\n\n- Action item 1",
});

const result = await scratchpad.read(scratchpadPath("shared/notes.md"));
if (result.ok) {
  console.log(result.value.content);    // "# Meeting notes\n..."
  console.log(result.value.generation); // 1
}
```

### CAS conflict handling

```typescript
const entry = await scratchpad.read(scratchpadPath("counter.txt"));
if (!entry.ok) return;

const newCount = parseInt(entry.value.content) + 1;
const writeResult = await scratchpad.write({
  path: scratchpadPath("counter.txt"),
  content: String(newCount),
  expectedGeneration: entry.value.generation,
});

if (!writeResult.ok && writeResult.error.code === "CONFLICT") {
  // Another agent wrote first — retry with fresh read
}
```

---

## Design decisions

| Decision | Rationale |
|---|---|
| Per-file CAS (not whole-store) | Fine-grained concurrency — agents writing different files never conflict |
| Client-side write buffer | Reduces RPC round-trips; coalesces rapid writes within a turn |
| Flush-on-read consistency | Ensures read-after-write semantics without server-side transactions |
| Generation-based cache | Lightweight probe avoids transferring unchanged data |
| LRU eviction (not TTL) | Predictable memory bound; server handles TTL expiry |
| Path validation client-side | Fail fast before network I/O; defence in depth with server validation |
| Structured tools (not raw RPC) | LLM agents use typed tool schemas, not raw Nexus RPC |

---

## Layer compliance

```
L2 @koi/scratchpad-nexus
    runtime deps: @koi/core (L0), @koi/nexus-client (L0u)
    devDeps: @koi/test-utils (L0u)
    zero L1 imports
    zero peer L2 imports
    ✓ safe to import from any L2, L3, or application code
```

---

## Related

- [`@koi/core` scratchpad types](../../packages/core/src/scratchpad.ts) — L0 contracts (ScratchpadComponent, ScratchpadEntry, etc.)
- [`@koi/core` SCRATCHPAD token](../../packages/core/src/ecs.ts) — well-known ECS component token
- [`@koi/nexus-client`](./nexus-client.md) — underlying Nexus RPC transport
- [`@koi/ipc-nexus`](./ipc-nexus.md) — sibling package using same Nexus patterns for IPC mailbox
- Issue [#630](https://github.com/windoliver/koi/issues/630) — process model gap analysis that motivated this package
