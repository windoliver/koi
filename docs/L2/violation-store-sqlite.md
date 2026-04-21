# @koi/violation-store-sqlite

Append-only SQLite-backed implementation of `ViolationStore` (L0 contract in
`@koi/core/governance-backend`). Indexed by timestamp, agent, and severity for
the `/governance` history view.

## Scope

One sentence: persists governance violations to SQLite for history queries.

## Install / layer

- Layer: L2
- Depends on: `@koi/core`, `@koi/errors`
- Consumers: `@koi/runtime` (dep), `packages/meta/cli/src/runtime-factory.ts` (wiring)

## Config

```ts
interface SqliteViolationStoreConfig {
  readonly dbPath: string;           // ":memory:" allowed in tests
  readonly flushIntervalMs?: number; // default 2000
  readonly maxBufferSize?: number;   // default 100
}
```

## Factory

```ts
import { createSqliteViolationStore } from "@koi/violation-store-sqlite";

const store = createSqliteViolationStore({ dbPath: "/var/koi/violations.db" });

store.record(violation, agentId, sessionId, Date.now());
const page = await store.getViolations({ sessionId, limit: 50 });
```

## Schema

| Column         | Type    | Notes                                  |
|----------------|---------|----------------------------------------|
| `id`           | INTEGER | AUTOINCREMENT primary key              |
| `timestamp`    | INTEGER | UNIX ms                                |
| `rule`         | TEXT    | Violation rule id                      |
| `severity`     | TEXT    | `info` / `warning` / `critical`        |
| `message`      | TEXT    | Human-readable                         |
| `context_json` | TEXT    | Nullable, JSON of `Violation.context`  |
| `agent_id`     | TEXT    | Acting agent                           |
| `session_id`   | TEXT    | Nullable (agent-scoped violations)     |

Indexes: `(timestamp DESC)`, `(agent_id, timestamp DESC)`, `(severity, timestamp DESC)`.

WAL mode is enabled via `PRAGMA journal_mode = WAL`.

## Append-only guarantee

No `UPDATE` or `DELETE` SQL statements exist in the package. A unit test
asserts the source contains no such substrings. Administrators who need to
truncate the DB must drop and recreate the file.

## Filters

`getViolations(filter)` supports:
- `agentId`, `sessionId`, `rule` — exact match
- `severity` — at-or-above, using `VIOLATION_SEVERITY_ORDER`
- `since`, `until` — inclusive/exclusive timestamp bounds
- `limit` — defaults to `DEFAULT_VIOLATION_QUERY_LIMIT` (100)
- `offset` — opaque cursor encoding the last-seen `id`

Returns `ViolationPage { items, cursor?, total? }`.
