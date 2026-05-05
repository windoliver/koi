# @koi/channel-signal

**Layer:** L2 · **Contract:** `ChannelAdapter` (L0)

ChannelAdapter for Signal via the `signal-cli` binary running in
JSON-RPC mode. Communicates over a child-process pipe — no SDK is required
because the official Signal protocol implementation is `libsignal` (C++),
and `signal-cli` is the de-facto CLI wrapper. The caller owns the
account registration; the adapter only owns the long-running subprocess.

## What it owns

- `createSignalChannel(config)` factory
- Subprocess lifecycle (`spawn` / SIGTERM / SIGKILL fallback)
- Newline-delimited JSON parser for stdout
- JSON-RPC `send` command construction (DM and group)
- Normalization of `dataMessage` events into `InboundMessage`
- E.164 phone-number normalization
- threadId convention: `"<E.164>"` for DMs, `"group:<base64-groupId>"` for groups

## What it does NOT own

- `signal-cli` installation or account registration (caller's job)
- Java runtime detection — `signal-cli` requires JRE 21+
- Attachment downloads — `signal-cli` writes them to disk; this adapter
  only surfaces text bodies. Attachments are out of scope.
- Group management (creating groups, adding members)

## Dependencies

| Package | Layer | Purpose |
| ------- | ----- | ------- |
| `@koi/core` | L0 | `ChannelAdapter`, `ContentBlock` types |
| `@koi/channel-base` | L0u | `createChannelAdapter()` factory |

No external runtime npm dependencies. The subprocess shape is pluggable
via `SpawnFn` so tests inject a fake without touching the real binary.

## API

### `createSignalChannel(config): ChannelAdapter`

### `SignalChannelConfig`

| Field | Type | Default | Description |
| ----- | ---- | ------- | ----------- |
| `account` | `string` (E.164) | required | Bot's registered phone number |
| `signalCliPath` | `string?` | `"signal-cli"` | Path to the signal-cli binary |
| `configPath` | `string?` | undefined | `--config` arg for signal-cli |
| `spawn` | `SpawnFn?` | Bun.spawn-based default | Test-only injected spawn |

### Capabilities

```ts
{ text: true, images: false, files: false, buttons: false,
  audio: false, video: false, threads: true, supportsA2ui: false }
```

Non-text blocks are downgraded to bracketed text (`[Image: <alt>]`,
`[File: <name>]`, `[<button label>]`) before send.

## threadId convention

| Source | threadId |
| ------ | -------- |
| DM | `"<senderE164>"` (e.g. `"+15551234567"`) |
| Group | `"group:<groupIdBase64>"` |

Inbound normalizer always emits a normalized E.164 form; outbound `send()`
parses the prefix to choose between `recipient` and `groupId` JSON-RPC params.

## Security

- `account` and incoming sender numbers are E.164-normalized before use —
  rejects malformed inputs at construction
- Subprocess gets a clean argv (no shell interpolation)
- Shutdown path: SIGTERM, then SIGKILL after `SIGNAL_SHUTDOWN_TIMEOUT_MS`
- Receipt + typing events are dropped (not surfaced as InboundMessage)

## Reference

Trimmed from `archive/v1/packages/net/channel-signal`. v2 changes:
- Standardized group threadId prefix `group:` (v1 had inconsistent inbound /
  outbound encodings for groups)
- Dropped `descriptor.ts` and the debouncer (premature for v2)
- Subprocess parser keeps the same envelope handling
