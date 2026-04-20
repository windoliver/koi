# `@koi/watch-patterns` (L0u)

Linear-time regex matcher, line buffer, and pending-match store.

## What it does

- Compile a small list of regex `watch_patterns` via `re2-wasm` (linear-time; no catastrophic backtracking).
- Feed bytes through `createLineBufferedMatcher(...).writeStdout(taskId, chunk)` / `writeStderr(...)`. Each stream has its own decoder, line buffer, and `lineNumber` counter.
- Matches land in a `PendingMatchStore` keyed by `(taskId, event, stream)` with explicit `peek`/`ack` semantics — non-destructive peek + success-gated ack makes delivery survive `@koi/middleware-semantic-retry`'s separate-request retry model.

## Not in scope

- Networking, persistence, or any subprocess/shell management — this package is pure string→events transformation.
- Binary / non-UTF-8 subprocess output. Invalid UTF-8 decodes to U+FFFD; use raw `task_output` for binary-aware retrieval.
- Patterns larger than 256 chars. Events not matching `/^(?!__)[a-z0-9_-]{1,64}$/`. More than 16 patterns per spawn.

## Contracts

See `src/index.ts` re-exports — `compilePatterns`, `createLineBufferedMatcher`, `createPendingMatchStore` and their accompanying types.

## Reserved events

- `__watch_overflow__` — emitted once per stream when the matcher hits a 16 KB newline-free line.
- `__watch_dropped__` — emitted for each `(taskId, event, stream)` bucket evicted when the store exceeds 256 live buckets.
- `__watch_dropped_older__` — emitted once when the tombstone list itself overflows at 4096 entries.

All reserved events are rejected from user-supplied `event` names at compile time.
