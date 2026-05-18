# @koi/sensor-neuroskill

**Layer:** L2 · **Contract:** `SignalSource` (L0)

Real-time BCI/EXG signal sensor for host integrations. Hosts can either feed
validated frames directly with `record()` or connect a WebSocket stream with
`connect(url)`. Each accepted frame is preprocessed synchronously, converted
into signal features, estimated as cognitive state, and emitted to subscribers.

## What it owns

- Normalized BCI/EXG frame and channel types
- WebSocket receiver lifecycle with injectable socket construction
- Per-frame preprocessing:
  - finite-sample validation
  - bounded sample counts
  - median baseline removal
  - robust outlier clipping
- Feature extraction:
  - mean, RMS, variance, peak amplitude
  - zero-crossing rate
  - EEG band powers: delta, theta, alpha, beta, gamma
- Cognitive-state estimates:
  - attention
  - fatigue
  - engagement
  - confidence
- Bounded recent cognitive-state event summaries
- `SignalSource.read()` integration for `@koi/middleware-user-model`

## What it does NOT own

- Hardware drivers, BLE, USB, or serial device discovery
- Long-term raw signal persistence
- Batch/offline signal processing
- Medical diagnosis, clinical interpretation, or calibration workflows
- Runtime wiring into a specific host or gateway

## Dependencies

| Package | Layer | Purpose |
|---------|-------|---------|
| `@koi/core` | L0 | `SignalSource`, `UserSignal` |

## API

### `createNeuroSkillSensor(config?): NeuroSkillSensor`

Returns a `SignalSource`-compatible object with:

| Method | Description |
|--------|-------------|
| `connect(url)` | Open a WebSocket stream. Use `socketFactory` in config for hosts/tests that provide their own transport. |
| `disconnect()` | Close the active socket and mark the sensor disconnected. |
| `record(frame)` | Validate and process one normalized frame immediately. Returns `true` when accepted. |
| `subscribe(handler)` | Observe cognitive-state events as frames are accepted. Returns an unsubscribe function. |
| `snapshot()` | Return current connection state, latest features, latest cognitive estimate, rejected-frame count, and bounded event summaries. |
| `read()` | Return `{ kind: "sensor", source: "neuroskill", values: snapshot() }`. |
| `clear()` | Drop retained in-memory state and rejected-frame count. |

### Frame Shape

```ts
{
  timestamp: number;
  samplingRateHz: number;
  channels: readonly {
    name: string;
    type?: "eeg" | "emg" | "eog" | "ecg" | "unknown";
    samples: readonly number[];
  }[];
}
```

Frames are processed as they arrive. There is no timer, queue, or batch window in
the sensor; rolling retention only bounds memory for snapshots.
