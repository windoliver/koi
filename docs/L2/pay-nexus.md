# @koi/pay-nexus — Nexus-Backed Credit Ledger

Persistent `PayLedger` implementation that talks to the Nexus pay API (TigerBeetle + PostgreSQL). Replaces the in-memory `createInMemoryPayLedger` from `@koi/middleware-pay` with a real credit system: balances survive restarts, costs aggregate across sessions, and agents can transfer credits.

---

## Why It Exists

`@koi/middleware-pay` enforces per-session token budgets with an in-memory `PayLedger`. This works for single sessions but breaks down at scale:

```
                  In-Memory Ledger          Nexus PayLedger
                  ─────────────────         ───────────────
Storage:          JS Map (RAM)              TigerBeetle + PostgreSQL
Durability:       None                      Full (double-entry ledger)
Restart:          Costs lost                Costs preserved
Multi-session:    Isolated per session      Shared credit pool
Agent-to-agent:   Not possible              Transfer credits
Reservations:     Not possible              Reserve → commit/release
Audit trail:      None                      PostgreSQL event log
```

`@koi/pay-nexus` solves all of these by delegating to the Nexus pay API.

---

## Architecture

### Layer Position

```
L0   @koi/core              ─ PayLedger, PayBalance, PayReceipt, Result, KoiError
L0u  @koi/resolve           ─ BrickDescriptor (manifest auto-resolution)
L2   @koi/pay-nexus         ─ this package
```

Imports from L0 + L0u only. Never touches `@koi/engine` (L1) or any peer L2 package.

### Internal Module Map

```
index.ts                    ← public re-exports
│
├── config.ts               ← NexusPayLedgerConfig + validatePayLedgerConfig()
├── ledger.ts               ← createNexusPayLedger() — HTTP client + PayLedger impl
├── descriptor.ts           ← BrickDescriptor for manifest auto-resolution
├── config.test.ts          ← config validation tests (10 cases)
├── ledger.test.ts          ← HTTP client tests (22 cases)
└── __tests__/
    └── api-surface.test.ts ← .d.ts snapshot stability
```

### How It Fits

```
  Agent Session              @koi/middleware-pay         @koi/pay-nexus
 ┌─────────────┐           ┌──────────────────┐        ┌──────────────┐
 │ model call   │──tokens──▶│ PayMiddleware    │        │ PayLedger    │
 │ tool call    │           │                  │        │              │
 │ model call   │           │ PayLedger ◄──────┼────────┤  meter()     │
 └─────────────┘           │  .meter()        │direct  │  getBalance()│
                            │  .getBalance()   │        │  reserve()   │
                            └──────────────────┘        │  transfer()  │
                                                        └──────┬───────┘
                                                               │ HTTPS
                                                               ▼
                                                        ┌──────────────┐
                                                        │ Nexus Pay API│
                                                        │ /api/v2/pay/ │
                                                        ├──────────────┤
                                                        │ TigerBeetle  │
                                                        │ PostgreSQL   │
                                                        └──────────────┘
```

---

## Data Flow

### Meter Usage (record a cost)

```
middleware-pay               PayLedger (Nexus)           Nexus Pay API
  │                            │                            │
  │  ledger.meter(             │                            │
  │    "0.05", "model_call")  │                            │
  │ ──────────────────────────>│                            │
  │                            │  POST /api/v2/pay/meter   │
  │                            │  { amount: "0.05",        │
  │                            │    event_type: "model_call"}│
  │                            │ ──────────────────────────>│
  │                            │                            │
  │                            │  { success: true }        │
  │                            │ <──────────────────────────│
  │  PayMeterResult            │                            │
  │ <──────────────────────────│                            │
```

### Check Remaining Budget

```
middleware-pay               PayLedger (Nexus)           Nexus Pay API
  │                            │                            │
  │  ledger.getBalance()      │                            │
  │ ──────────────────────────>│                            │
  │                            │  GET /api/v2/pay/balance  │
  │                            │ ──────────────────────────>│
  │                            │                            │
  │                            │  { available: "75.00",    │
  │                            │    reserved: "5.00",      │
  │                            │    total: "80.00" }       │
  │                            │ <──────────────────────────│
  │                            │                            │
  │  PayBalance                │                            │
  │ <──────────────────────────│                            │
```

### Reserve → Commit (atomic budget allocation)

```
caller                       PayLedger                  Nexus Pay API
  │                            │                            │
  │  reserve("10.00",         │                            │
  │    3600, "model call")    │                            │
  │ ──────────────────────────>│  POST /api/v2/pay/reserve │
  │                            │ ──────────────────────────>│
  │                            │                            │
  │  { id: "rsv-001",         │  { id, amount, purpose,   │
  │    status: "pending" }    │    expires_at, status }    │
  │ <──────────────────────────│ <──────────────────────────│
  │                            │                            │
  │  ... do expensive work ... │                            │
  │                            │                            │
  │  commit("rsv-001",        │                            │
  │    "7.50")                │  POST .../rsv-001/commit   │
  │ ──────────────────────────>│  { actual_amount: "7.50" }│
  │                            │ ──────────────────────────>│
  │                            │                            │
  │  void                      │  204 No Content           │
  │ <──────────────────────────│ <──────────────────────────│
```

---

## API Reference

### Factory

#### `createNexusPayLedger(config)`

Creates a Nexus-backed `PayLedger`.

```typescript
import { createNexusPayLedger } from "@koi/pay-nexus";
```

**Config:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `baseUrl` | `string` | required | Nexus pay API URL |
| `apiKey` | `string` | required | API key for authentication |
| `timeout` | `number` | `10_000` | Request timeout in milliseconds |
| `fetch` | `typeof fetch` | `globalThis.fetch` | Injectable fetch for testing |

### PayLedger Methods

| Method | Signature | API Endpoint |
|--------|-----------|--------------|
| `getBalance` | `() → PayBalance` | `GET /api/v2/pay/balance` |
| `canAfford` | `(amount) → PayCanAffordResult` | `GET /api/v2/pay/can-afford?amount=` |
| `transfer` | `(to, amount, memo?) → PayReceipt` | `POST /api/v2/pay/transfer` |
| `reserve` | `(amount, timeout?, purpose?) → PayReservation` | `POST /api/v2/pay/reserve` |
| `commit` | `(reservationId, actualAmount?) → void` | `POST /api/v2/pay/reserve/{id}/commit` |
| `release` | `(reservationId) → void` | `POST /api/v2/pay/reserve/{id}/release` |
| `meter` | `(amount, eventType?) → PayMeterResult` | `POST /api/v2/pay/meter` |

### Error Mapping

| HTTP Status | KoiError Code | Retryable | Meaning |
|-------------|---------------|-----------|---------|
| 401 | `PERMISSION` | No | Invalid API key |
| 402 | `RATE_LIMIT` | Yes | Insufficient credits |
| 403 | `PERMISSION` | No | Budget exceeded |
| 404 | `NOT_FOUND` | No | Resource not found |
| 409 | `CONFLICT` | No | Reservation conflict |
| 429 | `RATE_LIMIT` | Yes | Rate limited |
| 5xx | `EXTERNAL` | Yes | Server error |

---

## Examples

### 1. Drop-in replacement for in-memory ledger

```typescript
// Before: costs vanish on restart
import { createInMemoryPayLedger } from "@koi/middleware-pay";
const ledger = createInMemoryPayLedger(50.0);

// After: costs persist in Nexus
import { createNexusPayLedger } from "@koi/pay-nexus";
const ledger = createNexusPayLedger({
  baseUrl: process.env.NEXUS_PAY_URL!,
  apiKey: process.env.NEXUS_PAY_KEY!,
});

// Same interface — middleware-pay doesn't know the difference
const middleware = createPayMiddleware({
  ledger,
  calculator: createDefaultCostCalculator(),
  budget: 50.0,
});
```

### 2. Direct PayLedger usage (advanced)

```typescript
import { createNexusPayLedger } from "@koi/pay-nexus";

const ledger = createNexusPayLedger({
  baseUrl: "https://pay.nexus.example.com",
  apiKey: process.env.NEXUS_PAY_KEY!,
});

// Check balance
const balance = await ledger.getBalance();
console.log(`Available: $${balance.available}`);

// Reserve before expensive operation
const reservation = await ledger.reserve("5.00", 300, "claude-opus-call");

try {
  // ... run expensive model call ...
  const actualCost = 3.42;
  await ledger.commit(reservation.id, actualCost.toString());
} catch {
  // Release reservation on failure — credits return to available
  await ledger.release(reservation.id);
}
```

### 3. Agent-to-agent credit transfer

```typescript
// Agent A pays Agent B for delegated work
const receipt = await ledger.transfer(
  "agent-b",
  "10.00",
  "Payment for code review task",
);
console.log(`Transfer ${receipt.id}: $${receipt.amount} to ${receipt.toAgent}`);
```

### 4. Manifest-driven usage (via descriptor)

```yaml
# agent.koi.yaml
middleware:
  - name: pay-nexus
    options:
      baseUrl: ${NEXUS_PAY_URL}
      apiKey: ${NEXUS_PAY_KEY}
```

---

## Backend Pluggability

The `PayLedger` interface (L0) is the swap point. Change one line to switch backends:

```
┌──────────────────────────────────────────────────────────┐
│  @koi/middleware-pay                                       │
│  Uses PayLedger — identical regardless of backend          │
└───────────────────────────────┬──────────────────────────┘
                                │
             ┌──────────────────┼──────────────────┐
             ▼                  ▼                  ▼
   ┌──────────────────┐ ┌──────────────┐ ┌──────────────────┐
   │ In-Memory Ledger  │ │  (future)    │ │  pay-nexus       │
   │ Dev/testing only  │ │  SQLite      │ │  Production      │
   │ createInMemory..()│ │  ledger      │ │  createNexus..() │
   └──────────────────┘ └──────────────┘ └──────────────────┘
```

---

## Testing

### Unit tests (34 tests)

```bash
bun test packages/pay-nexus/src/
```

| File | Tests | Coverage |
|------|-------|---------|
| `config.test.ts` | 10 | Valid/invalid config, timeout, fetch validation |
| `ledger.test.ts` | 22 | All 7 API methods, HTTP error mapping, network/parse failures |
| `api-surface.test.ts` | 2 | .d.ts snapshot stability |

All mock-fetch based — no network calls in CI.

---

## Layer Compliance

```
L0  @koi/core ──────────────────────────────────────────────┐
    PayLedger, PayBalance, PayReceipt, PayReservation,       │
    PayMeterResult, PayCanAffordResult, KoiError, Result     │
                                                             │
L0u @koi/resolve ── BrickDescriptor ────────────────────────┤
                                                             ▼
L2  @koi/pay-nexus ◄────────────────────────────────────────┘
    imports from L0 + L0u only
    ✗ never imports @koi/engine (L1)
    ✗ never imports peer L2 packages
```
