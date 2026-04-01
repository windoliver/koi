# @koi/registry-sqlite

SQLite-backed implementations of the three L0 registry contracts:
BrickRegistry, SkillRegistry, and VersionIndex. Provides persistent
storage with FTS5 full-text search, keyset cursor pagination, and
reactive onChange event dispatch.

**Layer:** L2 (depends on `@koi/core` + `@koi/sqlite-utils` only)

## How It Works

```
  Consumer                   registry-sqlite                  SQLite
    |                             |                            |
    |  createSqlite*Registry()    |                            |
    |  { db | dbPath }            |                            |
    |---------------------------->|  applyRegistryMigrations    |
    |                             |---------------------------->|
    |                             |  FTS5 + indexes created     |
    |                             |<----------------------------|
    |                             |                            |
    |  register(brick)            |                            |
    |---------------------------->|  INSERT bricks + tags       |
    |                             |---------------------------->|
    |                             |  INSERT bricks_fts          |
    |                             |---------------------------->|
    |                             |                            |
    |  <-- onChange("registered") |                            |
    |                             |                            |
    |  search({ text, tags })     |                            |
    |---------------------------->|  SELECT bricks_fts MATCH ?  |
    |                             |---------------------------->|
    |                             |<----------------------------|
    |                             |  JOIN brick_tags WHERE IN   |
    |                             |---------------------------->|
    |                             |<----------------------------|
    |  <-- BrickPage { items,     |                            |
    |       total, cursor }       |                            |
    |                             |                            |
    |  close()                    |                            |
    |---------------------------->|  PRAGMA optimize            |
    |                             |---------------------------->|
    |                             |  db.close() (if owned)      |
    |                             |---------------------------->|
```

## Three Registries

| Registry | L0 Contract | Purpose |
|----------|-------------|---------|
| `createSqliteBrickRegistry` | `BrickRegistryBackend` | Store and discover tools + skills as brick artifacts |
| `createSqliteSkillRegistry` | `SkillRegistryBackend` | Publish/install skills with version control |
| `createSqliteVersionIndex` | `VersionIndexBackend` | Semver version tracking with deprecate/yank |

All three share the same SQLite database, the same migration runner, and
the same configuration pattern.

## Configuration

Two ways to provide a database:

```typescript
// Option 1: Let the factory own the database (opens + closes it)
const registry = createSqliteBrickRegistry({ dbPath: "./registry.db" });

// Option 2: Inject an existing database (caller owns lifecycle)
import { Database } from "bun:sqlite";
const db = new Database(":memory:");
db.run("PRAGMA foreign_keys = ON");
const registry = createSqliteBrickRegistry({ db });
```

When using `dbPath`, the factory opens the database and closes it on
`close()`. When injecting `db`, the factory never closes it — the caller
is responsible for lifecycle. Multiple registries can share one `db`:

```typescript
const db = new Database(":memory:");
db.run("PRAGMA foreign_keys = ON");

const bricks   = createSqliteBrickRegistry({ db });
const skills    = createSqliteSkillRegistry({ db });
const versions  = createSqliteVersionIndex({ db });
// All three share tables in the same database
```

## BrickRegistry

Store and discover `BrickArtifact` objects (tools, skills, agents).

### register

Upsert a brick. Fires `"registered"` on insert, `"updated"` on re-register.

```typescript
import { createTestToolArtifact } from "@koi/test-utils";

const brick = createTestToolArtifact({
  name: "multiply",
  description: "Multiplies two numbers",
  tags: ["math", "arithmetic"],
});

const result = await registry.register(brick);
// result.ok === true
```

### get

Retrieve a single brick by kind and name.

```typescript
const result = await registry.get("tool", "multiply");
if (result.ok) {
  console.log(result.value.description); // "Multiplies two numbers"
}
```

### search

Full-text search with tag filtering and keyset pagination.

```typescript
// Text search (FTS5)
const page = await registry.search({ text: "multiply" });
// page.items — matching bricks
// page.total — total count (before pagination)
// page.cursor — opaque cursor for next page (undefined = last page)

// Tag AND-filtering
const page = await registry.search({ tags: ["math", "arithmetic"] });
// Returns only bricks that have ALL specified tags

// Kind filter
const page = await registry.search({ kind: "tool" });

// Pagination
const page2 = await registry.search({ text: "math", cursor: page.cursor, limit: 10 });

// Combined
const page = await registry.search({ text: "calc", tags: ["math"], kind: "tool", limit: 5 });
```

### unregister

Remove a brick. Cascade-deletes associated tags. Fires `"unregistered"`.

```typescript
const result = await registry.unregister("tool", "multiply");
```

### onChange

Subscribe to mutation events. Returns an unsubscribe function.

```typescript
const unsub = registry.onChange((event) => {
  // event.kind: "registered" | "updated" | "unregistered"
  // event.brickKind: "tool" | "skill" | ...
  // event.name: brick name
  console.log(`${event.kind}: ${event.brickKind}:${event.name}`);
});

// Later: unsub() to stop listening
```

## SkillRegistry

Publish and install skills with multi-version support. Two-table design:
`skills` for catalog entries, `skill_versions` for version-specific content.

### publish

Publish a new skill or a new version of an existing skill.

```typescript
import { skillId } from "@koi/core";

const entry = await registry.publish({
  id: skillId("summarize"),
  name: "summarize",
  description: "Summarizes long documents",
  version: "1.0.0",
  content: "# Summarize Skill\nYou are a summarization expert...",
  tags: ["nlp", "text"],
});
// entry.ok === true
// entry.value.version === "1.0.0"

// Publish v2
await registry.publish({
  id: skillId("summarize"),
  name: "summarize",
  description: "Summarizes long documents (improved)",
  version: "2.0.0",
  content: "# Summarize Skill v2\nYou are an expert...",
  tags: ["nlp", "text"],
});
```

### install

Retrieve a skill as a `SkillArtifact`. Installs latest by default, or a
specific version. Increments download count.

```typescript
// Install latest
const result = await registry.install(skillId("summarize"));
// result.value.content === "# Summarize Skill v2..."
// result.value.version === "2.0.0"

// Install specific version
const v1 = await registry.install(skillId("summarize"), "1.0.0");
// v1.value.content === "# Summarize Skill\nYou are..."
```

### get

Retrieve a single skill entry by ID.

```typescript
const result = await registry.get(skillId("summarize"));
if (result.ok) {
  console.log(result.value.name);    // "summarize"
  console.log(result.value.version); // latest version string
}
```

### search

Full-text search with tag and author filtering. Same keyset pagination.

```typescript
const page = await registry.search({ text: "summarize" });
const page = await registry.search({ tags: ["nlp"], author: "koi-team" });
```

### versions

List all versions of a skill, ordered newest-first.

```typescript
const result = await registry.versions(skillId("summarize"));
// result.value: [{ version: "2.0.0", publishedAt: ... }, { version: "1.0.0", ... }]
```

### deprecate / unpublish

```typescript
// Soft-deprecate a specific version
await registry.deprecate(skillId("summarize"), "1.0.0");

// Hard-delete the entire skill (all versions, tags, FTS)
await registry.unpublish(skillId("summarize"));
```

### onChange

```typescript
registry.onChange((event) => {
  // event.kind: "published" | "deprecated" | "unpublished"
  // event.skillId: SkillId
  // event.version?: string (for published/deprecated)
});
```

## VersionIndex

Semver version tracking for any brick, with publisher attribution.
Separate from BrickRegistry — tracks which versions exist for a
(name, kind) pair without storing full brick data.

### publish

Register a version entry. Idempotent if same brickId.

```typescript
import { brickId, publisherId } from "@koi/core";

await index.publish(
  "multiply",                    // name
  "tool",                        // kind
  "1.0.0",                       // version
  brickId("brick_multiply_v1"),  // brickId
  publisherId("koi-team"),       // publisher
);

await index.publish("multiply", "tool", "2.0.0", brickId("brick_multiply_v2"), publisherId("koi-team"));
await index.publish("multiply", "tool", "3.0.0", brickId("brick_multiply_v3"), publisherId("koi-team"));
```

### resolve / resolveLatest

```typescript
// Resolve specific version
const v1 = await index.resolve("multiply", "tool", "1.0.0");
// v1.value.brickId === brickId("brick_multiply_v1")

// Resolve latest (by published_at, not semver)
const latest = await index.resolveLatest("multiply", "tool");
// latest.value.version === "3.0.0"
```

### listVersions

All versions ordered newest-first, with deprecation flags.

```typescript
const result = await index.listVersions("multiply", "tool");
// result.value: [
//   { version: "3.0.0", brickId: ..., publisher: ..., publishedAt: ... },
//   { version: "2.0.0", ..., deprecated: true },
//   { version: "1.0.0", ... },
// ]
```

### deprecate / yank

```typescript
// Soft-deprecate: sets deprecated flag, entry still resolvable
await index.deprecate("multiply", "tool", "2.0.0");

// Hard-yank: DELETE from database, no longer resolvable
await index.yank("multiply", "tool", "2.0.0");
```

### onChange

```typescript
index.onChange((event) => {
  // event.kind: "published" | "deprecated" | "yanked"
  // event.brickKind, event.name, event.version
  // event.brickId, event.publisher
});
```

## FTS5 Full-Text Search

Both BrickRegistry and SkillRegistry use SQLite FTS5 contentless virtual
tables for full-text search.

**Indexed columns:** `name`, `description`, `tags` (space-joined)

**Tokenizer:** `unicode61 remove_diacritics 1` (case-insensitive, Unicode-aware)

**Important:** FTS5 matches whole tokens, not substrings. Searching
`"calc"` will NOT match `"calculator"`. Search for the full token or use
the `*` prefix operator (which `sanitizeFtsQuery` currently strips for
safety).

**Query sanitization:** User input is sanitized before reaching FTS5.
The following are stripped: `" * ^ ( ) { } :` and boolean operators
`AND`, `OR`, `NOT`, `NEAR`. Hyphens are preserved but interpreted by
FTS5 as the NOT operator — avoid hyphens in names/tags if you need
reliable text search.

## Keyset Cursor Pagination

All search methods use keyset pagination instead of OFFSET. Cursors are
opaque base64url-encoded strings containing `(sortKey, rowid)` pairs.

```
Page 1: SELECT ... ORDER BY created_at DESC, rowid DESC LIMIT 4
        ┌─────────┬─────────┬─────────┬─────────┐
        │  row 7  │  row 6  │  row 5  │  row 4  │  ← cursor encodes row 4
        └─────────┴─────────┴─────────┴─────────┘

Page 2: SELECT ... WHERE (created_at < ? OR (created_at = ? AND rowid < ?))
        ORDER BY created_at DESC, rowid DESC LIMIT 4
        ┌─────────┬─────────┬─────────┐
        │  row 3  │  row 2  │  row 1  │  ← no cursor = last page
        └─────────┴─────────┴─────────┘
```

**Why keyset over OFFSET:**
- Stable under concurrent inserts/deletes (no skipped or duplicated rows)
- O(1) seek time via index (vs. O(n) for OFFSET)
- Deterministic with composite key `(timestamp DESC, rowid DESC)`

## onChange Events

All three registries support reactive event listeners via `onChange()`.
Events are dispatched synchronously after each mutation. Individual
listener errors are caught so one broken listener cannot block others.

| Registry | Events |
|----------|--------|
| BrickRegistry | `registered`, `updated`, `unregistered` |
| SkillRegistry | `published`, `deprecated`, `unpublished` |
| VersionIndex | `published`, `deprecated`, `yanked` |

Listeners must be subscribed **before** the mutation to receive the event.

## Swappable Backends

The SQLite implementation is one backend behind L0 interfaces. The same
contracts can be satisfied by any storage:

```
  BrickRegistryBackend          SkillRegistryBackend         VersionIndexBackend
  (L0 interface)                (L0 interface)               (L0 interface)
         |                             |                            |
    ┌────┴────┐                   ┌────┴────┐                  ┌────┴────┐
    |         |                   |         |                  |         |
 SQLite    Postgres            SQLite    Postgres           SQLite    Postgres
 (this)    (future)            (this)    (future)           (this)    (future)
```

Contract tests in `@koi/test-utils` (`testBrickRegistryContract`, etc.)
validate behavior — any backend that passes the contract tests is a
valid implementation.

```typescript
// Any backend plugs into the same contract test harness
testBrickRegistryContract({
  createRegistry: () => createSqliteBrickRegistry({ db }),
});

testBrickRegistryContract({
  createRegistry: () => createPostgresBrickRegistry({ pool }),
});
```

## Integration

### With createKoi (full L1 runtime)

```typescript
import { Database } from "bun:sqlite";
import { createKoi } from "@koi/engine";
import { createPiAdapter } from "@koi/engine-pi";
import { createSqliteBrickRegistry } from "@koi/registry-sqlite";

const db = new Database(":memory:");
db.run("PRAGMA foreign_keys = ON");
const registry = createSqliteBrickRegistry({ db });

// Register tools
await registry.register(myToolArtifact);

// Build a ComponentProvider that resolves tools from the registry
const registryProvider: ComponentProvider = {
  attach(agent) {
    // Discover registered tools and attach them to the agent entity
    const page = await registry.search({ kind: "tool" });
    for (const brick of page.items) {
      agent.set(toolToken(brick.name), brickToTool(brick));
    }
  },
};

// Wire through createKoi
const runtime = await createKoi({
  manifest: { name: "my-agent", version: "1.0.0", model: { name: "anthropic:claude-haiku-4-5-20251001" } },
  adapter: createPiAdapter({ model: "anthropic:claude-haiku-4-5-20251001", getApiKey: () => key }),
  providers: [registryProvider],
});

// LLM can now discover and call registered tools
for await (const event of runtime.run({ kind: "text", text: "Use multiply to compute 7 * 8" })) {
  // process events...
}

registry.close();
```

### Standalone (without engine)

```typescript
import { Database } from "bun:sqlite";
import { createSqliteBrickRegistry, createSqliteSkillRegistry, createSqliteVersionIndex } from "@koi/registry-sqlite";

const db = new Database("./my-registry.db");
db.run("PRAGMA foreign_keys = ON");

const bricks   = createSqliteBrickRegistry({ db });
const skills    = createSqliteSkillRegistry({ db });
const versions  = createSqliteVersionIndex({ db });

// Use registries directly
await bricks.register(toolArtifact);
await skills.publish({ id, name, version, content, ... });
await versions.publish(name, kind, version, brickId, publisherId);

// Search
const results = await bricks.search({ text: "calculator", tags: ["math"] });

// Clean up
bricks.close();
skills.close();
versions.close();
db.close();
```

## Schema

All tables are created by `applyRegistryMigrations()`, which is called
automatically by each factory. Migrations are idempotent and tracked via
`PRAGMA user_version`.

### V1 Tables

```sql
-- BRICK REGISTRY
bricks           -- main table with JSON data column
brick_tags       -- junction table (brick_rowid, tag) with CASCADE delete
bricks_fts       -- FTS5 contentless (name, description, tags)

-- SKILL REGISTRY
skills           -- catalog entries
skill_tags       -- junction table with CASCADE delete
skill_versions   -- version-specific content + integrity hash
skills_fts       -- FTS5 contentless (name, description, tags)

-- VERSION INDEX
versions         -- (name, kind, version) -> brickId + publisher
```

### Indexes

| Index | Purpose |
|-------|---------|
| `idx_bricks_kind` | Filter by brick kind |
| `idx_bricks_cursor` | Keyset pagination `(created_at DESC, rowid DESC)` |
| `idx_brick_tags_tag` | Tag lookup for AND-filtering |
| `idx_skills_cursor` | Keyset pagination for skills |
| `idx_skill_tags_tag` | Tag lookup for skills |
| `idx_sv_skill_published` | Version lookup by skill + publish order |
| `idx_versions_lookup` | Version resolution `(name, kind, published_at DESC)` |

## Testing

```bash
# Unit + contract tests (137 tests, no API key needed)
bun test

# E2E tests with real Anthropic API (6 tests)
E2E_TESTS=1 bun test src/__tests__/e2e-full-stack.test.ts

# Typecheck
bun run typecheck
```

## Architecture

```
packages/registry-sqlite/src/
├── index.ts              Public exports (3 factories + config types)
├── config.ts             Shared config: dbPath vs injected db
├── schema.ts             V1 DDL + migration runner
├── cursor.ts             Keyset cursor encode/decode (base64url)
├── fts-sanitize.ts       FTS5 query sanitization
├── listeners.ts          onChange event dispatch utility
├── brick-registry.ts     BrickRegistryBackend implementation
├── skill-registry.ts     SkillRegistryBackend implementation
├── version-index.ts      VersionIndexBackend implementation
└── __tests__/
    ├── brick-registry.test.ts    Contract + SQLite-specific tests
    ├── brick-resolver.test.ts    Resolver integration tests
    ├── skill-registry.test.ts    Skill publish/install/search tests
    ├── version-index.test.ts     Version publish/resolve/deprecate tests
    └── e2e-full-stack.test.ts    Full L1 runtime + real LLM (6 tests)
```

**Layer compliance:**
- Production code imports only `@koi/core` (L0) and `@koi/sqlite-utils` (L0u)
- Test code may import `@koi/engine` (L1) and `@koi/engine-pi` via devDependencies
- No L2 cross-imports
