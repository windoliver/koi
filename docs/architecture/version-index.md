# Versioned Brick Resolution

How version labels and publisher identity enable reproducible agent assembly.

## Why It Exists

Agents reference bricks by name only:

```yaml
tools:
  - calculator
```

This creates three problems:

1. **No reproducibility** — "calculator" could resolve to different code on different machines or at different times
2. **No publisher attribution** — no way to know who created a brick, so no trust chain
3. **No pinning** — agents can't lock to a known-good version

Since Koi uses content-addressed `BrickId` (SHA-256 hash of brick content, from #250), the content itself is immutable. What's missing is a **human-readable mapping layer** — version labels that point to content hashes, with publisher metadata.

## Architecture

```
  Layer    Package             What it provides
  ─────    ───────             ────────────────
  L0       @koi/core           VersionIndex contract (interfaces only)
                               VersionEntry, PublisherId, VersionChangeEvent types

  L0u      @koi/test-utils     In-memory reference implementation
                               Contract test suite (27 tests)

  L2       (future)            Persistent backends (SQLite, HTTP, etc.)
```

The VersionIndex is **orthogonal** to ForgeStore and BrickRegistry — it doesn't store brick content, it maps labels to content hashes. Think of it like DNS: names → addresses.

```
  VersionIndex                    BrickRegistry / ForgeStore
  ┌────────────────────┐          ┌────────────────────┐
  │ "calc" + "2.0.0"   │          │                    │
  │   → sha256-bbbb    │─────────►│  sha256-bbbb       │
  │   → publisher: alice│          │  = actual tool code │
  │   → publishedAt    │          │  = immutable        │
  │                    │          │                    │
  │ LABELS (mutable)   │          │ CONTENT (immutable) │
  └────────────────────┘          └────────────────────┘
```

## Core Concepts

### Content-Addressed Identity

BrickIds are SHA-256 hashes. A version label is a human-readable alias over that hash:

```
  version label       content hash
  ─────────────       ────────────
  "1.0.0"        →   sha256-aaaa
  "2.0.0"        →   sha256-bbbb
  "beta"         →   sha256-cccc
```

Labels are **bind-once** — once `"2.0.0"` maps to `sha256-bbbb`, it can never be re-bound to a different hash. Attempting to publish the same label with different content returns `CONFLICT`. Publishing the same label + same hash is idempotent (no-op).

### Publisher Identity

Every version entry records who published it via a branded `PublisherId` type:

```typescript
type PublisherId = string & { readonly [__publisherIdBrand]: "PublisherId" };
```

Multiple publishers can publish different versions of the same brick name. Publisher identity enables downstream trust decisions (not enforced by VersionIndex itself).

### Version Lifecycle

```
  publish(name, kind, version, brickId, publisher)
       │
       ▼
  ┌──────────┐    deprecate()    ┌──────────┐    yank()    ┌──────────┐
  │ PUBLISHED│──────────────────►│DEPRECATED│─────────────►│  YANKED  │
  │          │                   │(soft)    │              │(hard)    │
  │ resolve: │                   │ resolve: │              │ resolve: │
  │  ✓ found │                   │  ✓ found │              │  ✗ NOT_  │
  │          │                   │  + flag   │              │   FOUND  │
  └──────────┘                   └──────────┘              └──────────┘
```

- **Published** — resolvable, active
- **Deprecated** — still resolvable, but `entry.deprecated === true` signals consumers to upgrade
- **Yanked** — hard-removed, `resolve()` returns `NOT_FOUND`

## Contract: VersionIndex

### Reader (VersionIndexReader)

| Method | Signature | Behavior |
|--------|-----------|----------|
| `resolve` | `(name, kind, version) → Result<VersionEntry>` | Exact label lookup. `NOT_FOUND` if missing or yanked. |
| `resolveLatest` | `(name, kind) → Result<VersionEntry>` | Highest `publishedAt`. Falls back if latest is yanked. |
| `listVersions` | `(name, kind) → Result<readonly VersionEntry[]>` | All versions, newest first. `NOT_FOUND` if none. |
| `onChange` | `(listener) → unsubscribe` | Optional. Event-driven cache invalidation. |

### Writer (VersionIndexWriter)

| Method | Signature | Behavior |
|--------|-----------|----------|
| `publish` | `(name, kind, version, brickId, publisher) → Result<VersionEntry>` | Bind label → hash. `CONFLICT` if re-bind. Idempotent for same tuple. |
| `deprecate` | `(name, kind, version) → Result<void>` | Soft flag. Idempotent. `NOT_FOUND` if missing. |
| `yank` | `(name, kind, version) → Result<void>` | Hard remove. `NOT_FOUND` if missing. |

### Backend (VersionIndexBackend)

Extends both Reader and Writer. Implementations provide this interface.

All methods return `T | Promise<T>` — sync for in-memory, async for network backends.

## VersionEntry

```typescript
interface VersionEntry {
  readonly version: string;        // human-readable label
  readonly brickId: BrickId;       // content-addressed hash
  readonly publisher: PublisherId; // who published
  readonly publishedAt: number;    // unix epoch ms
  readonly deprecated?: boolean;   // soft-deprecation flag
}
```

## Manifest Integration

Tool, channel, and middleware configs now accept optional `version` and `publisher` fields:

```yaml
# koi.yaml
name: my-agent
version: 1.0.0
model: anthropic:claude-sonnet-4-5-20250929

tools:
  - name: calculator
    version: "2.0.0"         # pin to exact version label
    publisher: "alice"        # only accept from this publisher

middleware:
  - name: "@koi/mw-audit"
    version: "1.0.0"

channels:
  - name: "@koi/channel-cli"
    version: "3.1.0"
    publisher: "koi-team"
```

These fields are `string` (not branded types) in the manifest schema because YAML is user-authored. Branding to `PublisherId` happens at resolution time.

## Change Events

VersionIndex supports optional `onChange()` for real-time cache invalidation:

```typescript
type VersionChangeKind = "published" | "deprecated" | "yanked";

interface VersionChangeEvent {
  readonly kind: VersionChangeKind;
  readonly brickKind: BrickKind;
  readonly name: string;
  readonly version: string;
  readonly brickId: BrickId;
  readonly publisher: PublisherId;
}
```

Listeners are notified on publish (new binding), deprecate (first deprecation only, idempotent calls don't re-fire), and yank (removal).

## Error Handling

| Error Code | When | Retryable |
|------------|------|-----------|
| `NOT_FOUND` | Version label doesn't exist or was yanked | No |
| `CONFLICT` | Same label already bound to a different BrickId | Yes (with merge) |
| `VALIDATION` | Empty or whitespace-only name/version | No |

## Testing

### Contract Test Suite

`@koi/test-utils` exports a reusable contract test suite:

```typescript
import { describe } from "bun:test";
import { createInMemoryVersionIndex, testVersionIndexContract } from "@koi/test-utils";

describe("MyVersionIndex", () => {
  testVersionIndexContract({
    createIndex: () => createMyBackend(),
  });
});
```

The suite validates 27 invariants across 9 groups:

1. **publish** — happy path, idempotent, conflict, validation
2. **resolve** — exact lookup, not found
3. **resolveLatest** — newest by publishedAt, fallback after yank, not found
4. **listVersions** — newest-first ordering, not found
5. **deprecate** — soft flag, idempotent, not found
6. **yank** — hard remove, not found
7. **onChange** — fires on publish/deprecate/yank, unsubscribe, idempotent unsubscribe
8. **round-trip** — publish → resolve → list → deprecate → resolve (flag set)
9. **multi-publisher** — two publishers, same brick name, different versions

### In-Memory Reference Implementation

```typescript
import { createInMemoryVersionIndex } from "@koi/test-utils";

const index = createInMemoryVersionIndex();
```

All methods are synchronous. Uses a monotonic timestamp counter to guarantee ordering even when publishes happen within the same millisecond.

## How It Connects to Other Systems

```
  ┌─────────────┐     ┌──────────────┐     ┌──────────────┐
  │ Manifest    │     │ VersionIndex │     │ BrickRegistry│
  │ (koi.yaml)  │     │              │     │              │
  │ name +      │────►│ resolve()    │────►│ get(brickId) │
  │ version +   │     │ → BrickId    │     │ → artifact   │
  │ publisher   │     │ → publisher  │     │              │
  └─────────────┘     └──────────────┘     └──────────────┘
                             │
                             │ onChange()
                             ▼
                      ┌──────────────┐
                      │ Cache / UI   │
                      │ invalidation │
                      └──────────────┘
```

- **Manifest** provides the version request (name + optional version/publisher)
- **VersionIndex** resolves the label to an immutable content hash
- **BrickRegistry** fetches the actual artifact by hash
- **onChange** notifies caches and UIs of version changes

## Related

- [Brick Auto-Discovery](./brick-auto-discovery.md) — how forged bricks become available on agents
- [Manifest Resolution](./manifest-resolution.md) — how YAML becomes a running agent
- [Forge](../L2/forge.md) — self-extension runtime (creates the bricks that get versioned)
- GitHub: [#78](https://github.com/windoliver/koi/issues/78) — Versioned brick resolution
- GitHub: [#250](https://github.com/windoliver/koi/issues/250) — Content-addressed BrickId (prerequisite)
