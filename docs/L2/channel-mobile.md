# @koi/channel-mobile

**Layer:** L2 · **Contract:** `ChannelAdapter` (L0)

ChannelAdapter for native mobile apps. Hosts a Bun WebSocket server that mobile
clients connect to and exchange JSON frames over. Includes an in-memory offline
queue: while no client is connected, outbound messages are buffered and flushed
on the next connect.

## What it owns

- `ChannelAdapter` implementation backed by `Bun.serve({ websocket })`
- JSON frame protocol (`{ kind: "msg" | "ack", content?, ... }`)
- Single-client semantics — most recent connect wins; older socket closed
- In-memory offline queue (FIFO, capped at `maxOfflineQueue`)
- Capabilities declaration (`{ text: true, images: true, files: true, buttons: true }`)

## What it does NOT own

- Push notification delivery — injected via optional `pushNotifier` callback;
  the host wires APNs / FCM
- TLS / authentication — transport-layer; host runs a reverse proxy
- Persistent storage of offline queue — process-local only by design
- Multi-device fan-out — single subscriber per channel instance

## Dependencies

| Package | Layer | Purpose |
|---------|-------|---------|
| `@koi/core` | L0 | `ChannelAdapter`, message types |
| `@koi/channel-base` | L0u | `createChannelAdapter()` factory |

## API

### `createMobileChannel(config): MobileChannelAdapter`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `port` | `number` | `8080` | WebSocket port |
| `senderId?` | `string` | `"mobile-user"` | Default sender ID |
| `maxOfflineQueue?` | `number` | `100` | Max buffered outbound frames |
| `pushNotifier?` | `(msg) => Promise<void>` | `undefined` | Called per outbound while no client connected |

`MobileChannelAdapter extends ChannelAdapter` and exposes `queueDepth: () => number` for tests/observability.

## Wire format

```
client → server: {"kind":"msg","content":[{"kind":"text","text":"hi"}]}
server → client: {"kind":"msg","content":[...],"timestamp":123}
client → server: {"kind":"ack","ref":"<uuid>"}    (optional)
```
