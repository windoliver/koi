# Local Backends — Offline-First Koi

Four L2 packages that provide local implementations of Koi's core subsystems. Every network service now has an in-process equivalent, so `koi start` works without a Nexus server.

---

## Why They Exist

Without local backends, Koi is anchored to a running Nexus server. That means:

- `koi start` fails offline
- CI tests require external services
- Edge deployments need network connectivity
- Local development needs infrastructure setup

```
  BEFORE                              AFTER
  ──────                              ─────

  Agent ──── HTTP ────▶ Nexus         Agent ──── direct call ────▶ In-Memory
                                      Agent ──── direct call ────▶ SQLite

  ❌ Requires Nexus server             ✅ Works fully offline
  ❌ CI needs external services        ✅ Zero-dependency CI
  ❌ No edge deployment               ✅ Edge-ready (single binary)
  ❌ Network latency on every op      ✅ Microsecond local ops
```

The Linux design principle: **every network service must have a local equivalent.** These four packages close that gap.

---

## Packages

| Package | Subsystem | Storage | L0 Contract |
|---------|-----------|---------|-------------|
| `@koi/pay-local` | Budget & metering | In-memory + optional SQLite | `PayLedger` |
| `@koi/audit-sink-local` | Audit logging | SQLite or NDJSON file | `AuditSink` |
| `@koi/scratchpad-local` | Shared key-value store | In-memory | `ScratchpadComponent` |
| `@koi/ipc-local` | Inter-agent messaging | In-memory | `MailboxComponent` |

All four implement the same L0 contracts as their Nexus-backed counterparts. Swap in/out without changing agent code.

---

## Quick Start

```typescript
import { createLocalBackends } from "@koi/starter";

const backends = createLocalBackends({ initialBudget: "1000" });

// Use all 4 subsystems — identical API to Nexus-backed versions
backends.payLedger.meter("25");
backends.scratchpad.write({ path: "notes.txt", content: "hello" });
await backends.auditSink.log({ /* ... */ });
await backends.mailbox.send({ from: "agent-1", to: "agent-2", /* ... */ });

backends.close(); // Cleanup timers and state
```

---

## Architecture

All four packages are **L2 feature packages** — they depend only on `@koi/core` (L0) and L0u utilities. No L1 or peer L2 imports.

```
┌─────────────────────────────────────────────────────────────┐
│  @koi/starter  (L3)                                         │
│                                                             │
│  createLocalBackends() ─── wires all 4 together             │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│  L2 Feature Packages                                        │
│                                                             │
│  @koi/pay-local          PayLedger (append-only ledger)     │
│  @koi/audit-sink-local   AuditSink (SQLite batch + NDJSON)  │
│  @koi/scratchpad-local   ScratchpadComponent (CAS + TTL)    │
│  @koi/ipc-local          MailboxComponent (microtask IPC)   │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│  L0u Utilities                                              │
│                                                             │
│  @koi/sqlite-utils       openDb, mapSqliteError             │
│  @koi/test-utils         Contract test suites               │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│  L0 Core                                                    │
│                                                             │
│  @koi/core               PayLedger, AuditSink,              │
│                          ScratchpadComponent, MailboxComponent│
└─────────────────────────────────────────────────────────────┘
```

---

## Package Details

### @koi/pay-local

Append-only ledger with cached derived balance. O(1) per operation.

```typescript
import { createLocalPayLedger } from "@koi/pay-local";

const ledger = createLocalPayLedger({
  agentId: "agent-1",
  initialBudget: "1000",
  // dbPath: "./pay.db",  // Optional — SQLite persistence
});

// All 7 PayLedger methods implemented
const balance = ledger.getBalance();           // { available: "1000", reserved: "0", total: "1000" }
ledger.meter("50");                            // Deduct from budget
const canGo = ledger.canAfford("500");         // true
const res = ledger.reserve("200");             // Hold funds
ledger.commit(res.value.reservationId, "180"); // Settle (adjusted amount)
ledger.release(res.value.reservationId);       // Or release back
ledger.transfer("100", "agent-2", "payment");  // Agent-to-agent transfer

ledger.close();
```

**Key design:**
- Append-only entries (debit, credit, reserve, commit, release)
- Balance derived incrementally — never re-scanned
- Reservations tracked in Map with timeout cleanup (timers `unref()`'d)
- Optional SQLite via `@koi/sqlite-utils/openDb` for persistence across restarts

---

### @koi/audit-sink-local

Two backends: SQLite (batch inserts) and NDJSON (append-only file).

```typescript
import { createSqliteAuditSink } from "@koi/audit-sink-local";

const sink = createSqliteAuditSink({
  dbPath: ":memory:",           // Or "./audit.db" for persistence
  maxBufferSize: 100,           // Flush every 100 entries
  flushIntervalMs: 2_000,       // Or every 2 seconds
});

await sink.log({
  timestamp: Date.now(),
  sessionId: "s1",
  agentId: "agent-1",
  turnIndex: 0,
  kind: "tool_call",
  durationMs: 42,
});

await sink.flush();  // Force-flush buffered entries
sink.close();        // Flush remaining + close DB
```

**Key design:**
- Buffer + batch insert via `db.transaction()` for throughput
- Flush triggers: buffer full OR interval timer (whichever comes first)
- NDJSON alternative (`createNdjsonAuditSink`) for simpler use cases
- Timer `unref()`'d to prevent process hang

---

### @koi/scratchpad-local

In-memory key-value store with CAS (compare-and-swap) write semantics and TTL.

```typescript
import { createLocalScratchpad } from "@koi/scratchpad-local";

const pad = createLocalScratchpad({
  groupId: "group-1",
  authorId: "agent-1",
});

// CAS write semantics
pad.write({ path: "doc.md", content: "# Hello" });                    // Create
pad.write({ path: "doc.md", content: "# Updated", expectedGeneration: 1 }); // CAS update
pad.write({ path: "doc.md", content: "# Force" });                    // Unconditional

// TTL support
pad.write({ path: "temp.txt", content: "ephemeral", ttlSeconds: 60 });

// Read, list, delete
const entry = pad.read("doc.md");
const all = pad.list({ glob: "*.md", limit: 10 });
pad.delete("temp.txt");

// Change events
const unsub = pad.onChange((event) => console.log(event.kind, event.path));

pad.close();
```

**Key design:**
- CAS: `expectedGeneration: 0` = create-only, `> 0` = must match, `undefined` = unconditional
- TTL: lazy eviction on read/list + periodic sweep (60s, `unref()`'d)
- Limits enforced: `MAX_FILE_SIZE_BYTES`, `MAX_FILES_PER_GROUP`, `MAX_PATH_LENGTH`
- Path validation: rejects `..`, leading `/`, exceeding max length

---

### @koi/ipc-local

In-memory mailbox with microtask-deferred dispatch and a router for multi-agent setups.

```typescript
import { createLocalMailbox, createLocalMailboxRouter } from "@koi/ipc-local";

// Single agent
const mailbox = createLocalMailbox({ agentId: "agent-1" });

await mailbox.send({
  from: "agent-1",
  to: "agent-2",
  kind: "request",
  type: "code-review",
  payload: { file: "app.ts" },
});

const unsub = mailbox.onMessage((msg) => console.log(msg));
const messages = await mailbox.list({ kind: "request", limit: 5 });

// Multi-agent routing
const router = createLocalMailboxRouter();
const mailboxA = createLocalMailbox({ agentId: "agent-a" });
const mailboxB = createLocalMailbox({ agentId: "agent-b" });
router.register("agent-a", mailboxA);
router.register("agent-b", mailboxB);

// Send from A, delivered to B's mailbox
await router.route({
  from: "agent-a",
  to: "agent-b",
  kind: "event",
  type: "ping",
  payload: {},
});

mailbox.close();
```

**Key design:**
- Subscribers notified via `queueMicrotask()` — non-blocking dispatch
- FIFO eviction when at capacity (default 10,000 messages)
- Router maps `AgentId -> MailboxComponent` for in-process delivery

---

## Contract Tests

Every local backend passes the same contract test suite as its Nexus counterpart. The suites live in `@koi/test-utils`:

```typescript
import { runPayLedgerContractTests } from "@koi/test-utils";
import { createLocalPayLedger } from "@koi/pay-local";

// Runs ~20 tests verifying the PayLedger contract
runPayLedgerContractTests(() =>
  createLocalPayLedger({ agentId: "test", initialBudget: "1000" })
);
```

| Suite | Tests | Verifies |
|-------|-------|----------|
| `runPayLedgerContractTests` | ~20 | Balance, meter, reserve/commit/release, transfer, timeout |
| `runAuditSinkContractTests` | ~8 | Log, flush, all entry kinds, sequential writes |
| `runScratchpadContractTests` | ~25 | CAS, TTL, glob, limits, path validation, onChange |
| `runMailboxContractTests` | ~15 | Send/list, filters, ordering, subscribers, unique IDs |

---

## Use Cases

| Scenario | Configuration |
|----------|---------------|
| Local development | `createLocalBackends()` — all in-memory, zero setup |
| CI/CD testing | `createLocalBackends()` — no external services needed |
| Edge deployment | SQLite pay + audit for persistence, in-memory scratchpad + IPC |
| Integration tests | Contract test suites verify any backend implementation |
| Offline operation | Full Koi functionality without network connectivity |
