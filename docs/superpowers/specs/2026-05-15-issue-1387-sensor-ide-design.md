# Issue 1387 Sensor IDE Design

## Goal

Add a low-overhead IDE activity sensor for v2 that turns lightweight editor-plugin events into user-model sensor metrics: typing speed, diagnostic error rate, file-switch frequency, flow state, context-switch detection, frustration detection, and a bounded recent activity stream.

## Architecture

Create a new optional package, `@koi/sensor-ide`, instead of extending `@koi/channel-ide`. The IDE channel remains transport/message framing; the sensor is a pure in-memory component that any IDE plugin or host can feed with normalized activity events. The package exposes `createIdeActivitySensor(config?)`, which returns a `SignalSource`-compatible object plus `record()`, `subscribe()`, and `snapshot()` methods.

## Data Model

The sensor accepts bounded event objects:

- `edit`: inserted/deleted character counts for typing speed and sustained activity.
- `diagnostic`: latest per-file diagnostic counts for error metrics.
- `file_focus`: active file transitions for switch frequency and context-switch detection.
- `delete` and `undo`: correction bursts for frustration detection.

Events are pruned to a rolling window and capped by `maxEvents`, so memory and compute stay bounded. Accepted events are also emitted to local subscribers so hosts can build an activity stream without polling. No timers, I/O, filesystem reads, or editor API calls run inside the sensor.

## Metrics

`snapshot()` returns structured metrics. `read()` wraps those metrics as `UserSignal` with `kind: "sensor"` and `source: "ide"`.

- `typingSpeedCharsPerMinute`: inserted characters per minute across the retained edit window.
- `errorCount`: latest retained error diagnostics summed by file.
- `errorRatePerFile`: `errorCount / diagnosticFileCount`.
- `fileSwitchesPerMinute`: focus transitions per minute across retained focus events.
- `flowState`: true when sustained edit activity stays mostly in one file for a minimum duration.
- `contextSwitchDetected`: true when rapid focus transitions cross a threshold.
- `frustrationDetected`: true when delete/undo activity crosses a burst threshold.
- `recentEvents`: capped sanitized event summaries for downstream activity streams.

## Testing

Tests live in `packages/lib/sensor-ide/src/ide-activity-sensor.test.ts` and drive implementation with TDD. They cover every issue acceptance bullet and the bounded low-overhead stream behavior.
