# @koi/sensor-ide

**Layer:** L2 · **Contract:** `SignalSource` (L0)

Low-overhead IDE activity sensor for editor integrations. Hosts feed normalized
editor events into an in-memory rolling window; the sensor exposes a
`SignalSource.read()` result for `@koi/middleware-user-model`.

## What it owns

- Normalized IDE activity event types:
  - `edit`
  - `diagnostic`
  - `file_focus`
  - `delete`
  - `undo`
- Bounded rolling event retention by time window and `maxEvents`
- Typing speed from edit insertions
- Latest diagnostic error counts and error rate per file
- File-switch frequency from focus transitions
- Flow-state detection from sustained same-file edits over a minimum duration
- Context-switch detection from rapid file changes
- Frustration detection from delete/undo bursts
- Bounded recent activity summaries

## What it does NOT own

- IDE transport, sockets, pipes, or JSON-RPC framing
- LSP protocol integration
- Native VS Code, JetBrains, or editor APIs
- Persistence of raw activity events
- Background timers or polling loops

## Dependencies

| Package | Layer | Purpose |
|---------|-------|---------|
| `@koi/core` | L0 | `SignalSource`, `UserSignal` |

## API

### `createIdeActivitySensor(config?): IdeActivitySensor`

Returns a `SignalSource`-compatible object with:

| Method | Description |
|--------|-------------|
| `record(event)` | Add one normalized IDE activity event. Invalid timestamps or empty file paths are ignored. |
| `subscribe(handler)` | Observe accepted activity events as they arrive. Returns an unsubscribe function. |
| `snapshot()` | Return current metrics from retained events. |
| `read()` | Return `{ kind: "sensor", source: "ide", values: snapshot() }`. |
| `clear()` | Drop retained in-memory events. |

### Snapshot Metrics

```ts
{
  typingSpeedCharsPerMinute: number;
  errorCount: number;
  errorRatePerFile: number;
  fileSwitchesPerMinute: number;
  flowState: boolean;
  contextSwitchDetected: boolean;
  frustrationDetected: boolean;
  recentEvents: readonly IdeActivitySummaryEvent[];
  activeFileCount: number;
  sampledAt: number;
  windowMs: number;
}
```
