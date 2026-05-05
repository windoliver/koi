# @koi/channel-mobile

**Layer:** L2 · **Contract:** `ChannelAdapter` (L0)

ChannelAdapter for native mobile apps. Hosts a Bun WebSocket server. **Strict
single-client**: a second concurrent connection is rejected (not preempted),
which removes the entire class of cross-client misroute leaks. Outbound while
disconnected is handed to an optional `pushNotifier` (APNs/FCM) — the adapter
itself does NOT buffer outbound, because it cannot prove the next client to
connect is the same recipient.

## What it owns

- `ChannelAdapter` implementation backed by `Bun.serve({ websocket })`
- JSON frame protocol (`{ kind: "msg", content?, ... }`)
- Strict single-client gating: second concurrent connection is closed at `open`
- Inbound `senderId` dropped by default; honored only when `trustClientIdentity: true`
- Outbound while no client connected: forwarded to `pushNotifier` (no buffering)
- Capabilities declaration (`{ text: true, images: true, files: true, buttons: true, threads: false }`)

## What it does NOT own

- Push notification delivery — injected via `pushNotifier`; host wires APNs / FCM
- TLS / authentication — transport-layer; host runs a reverse proxy (mTLS, JWT)
- Persistent storage / replay / ack semantics — out of MVP. The host's push
  pipeline owns durability.
- Threading — `threads: false`. Without trusted client identity the adapter
  cannot uphold thread routing semantics, so the capability is not advertised.
- Multi-device fan-out — single connected client at a time, by design.

## Dependencies

| Package | Layer | Purpose |
|---------|-------|---------|
| `@koi/core` | L0 | `ChannelAdapter`, message types |
| `@koi/channel-base` | L0u | `createChannelAdapter()` factory |

## API

### `createMobileChannel(config): MobileChannelAdapter`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `port` | `number` | (required) | WebSocket port (`0` for ephemeral) |
| `senderId?` | `string` | `"mobile-user"` | Default sender ID stamped on inbound when client identity is untrusted |
| `pushNotifier?` | `(msg) => Promise<void>` | `undefined` | Called per outbound while no client connected. Failure non-fatal, not retried. |
| `trustClientIdentity?` | `boolean` | `false` | Trust client-supplied `senderId`. Only enable behind authenticated transport. |

`MobileChannelAdapter` is a type alias for `ChannelAdapter`.

## Wire format

```
client → server: {"kind":"msg","content":[{"kind":"text","text":"hi"}]}
server → client: {"kind":"msg","content":[...],"timestamp":123}
```
