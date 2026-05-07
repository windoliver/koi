# @koi/channel-mobile

**Layer:** L2 · **Contract:** `MobileChannelAdapter extends ChannelAdapter` (L0)

ChannelAdapter for native mobile apps. Hosts a Bun WebSocket server. Strict
single-client (rejects concurrent connections). No in-process buffering;
disconnected outbound goes to an optional `pushNotifier` (APNs/FCM).

## Trust model — fail-closed by default

`@koi/channel-mobile` is an **anonymous, single-socket** transport.
Cross-session reply leakage is prevented by a single rule: every outbound
after the first inbound MUST carry a valid correlation tag, otherwise
`send()` routes it to `pushNotifier` instead of the live socket.

1. **Strict single-client at the socket layer** — a second concurrent
   connection is rejected (not preempted); inbound frames from non-active
   sockets are dropped at `message()`. Eliminates the *concurrent* leak.
2. **HMAC-signed reply tag on the inbound** — every dispatched inbound
   carries `metadata.mobileSessionEpoch` + `metadata.mobileSessionMac`,
   signed with this adapter's private secret. `replyToInbound(inbound,
   message)` propagates the tag onto the outbound. The tag survives
   object cloning, queue serialization, and any wrapper that preserves
   the metadata field. Forgery requires the per-instance secret.
3. **AsyncLocalStorage convenience tag** — handler-chain `send()` calls
   inherit the originating session epoch via ALS without code changes.
   Detached callbacks lose this context; for those, hosts must use
   `replyToInbound()` so the HMAC tag rides on the message itself.
4. **`send()` is fail-closed once any inbound has dispatched** — outbound
   with no valid HMAC tag AND no matching ALS context routes to
   `pushNotifier` (or rejects). Any code path that forgot to use
   `replyToInbound()` for a late reply gets pushed instead of leaked.
5. **`sendUnsolicited()` is the explicit unsolicited path** — hosts that
   genuinely want to address whichever client is currently connected
   (welcome banners, resume notifications) call this method, not `send()`.
   The trust trade is opted into per call site, never silently inferred.
6. **No in-process buffering** — outbound while disconnected is forwarded
   to `pushNotifier` (or `send()` rejects). The adapter never replays a
   backlog to a future client.

`send()` BEFORE any inbound has happened is treated as host-initiated:
a host that issues outbound on a virgin channel necessarily knows the
only possible recipient is whoever is connected.

## What it owns

- `MobileChannelAdapter` implementation backed by `Bun.serve({ websocket })`
- JSON frame protocol (`{ kind: "msg", content?, ... }`)
- Strict single-client gating: second concurrent connection is closed at `open`
- Inbound `senderId` dropped by default; honored only when `trustClientIdentity: true`
- HMAC-signed reply tags on every dispatched inbound (per-instance secret)
- Strict-by-default `send()` routing with `sendUnsolicited()` escape hatch
- Outbound while no client connected: forwarded to `pushNotifier` (no buffering)
- Capabilities declaration (`{ text: true, images: true, files: true, buttons: true, threads: false }`)

## What it does NOT own

- Push notification delivery — injected via `pushNotifier`; host wires APNs / FCM
- TLS / authentication — transport-layer; host runs a reverse proxy (mTLS, JWT)
- Persistent storage / replay / ack semantics — host's push pipeline owns durability
- Threading — `threads: false`; the adapter cannot uphold thread routing without trusted client identity
- Multi-device fan-out — single connected client at a time, by design

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
| `pushNotifier?` | `(msg) => Promise<void>` | `undefined` | Called for outbound that has no live recipient. Failure propagates to `send()`. |
| `trustClientIdentity?` | `boolean` | `false` | Trust client-supplied `senderId`. Only enable behind authenticated transport. |

### `MobileChannelAdapter.sendUnsolicited(message): Promise<void>`

Explicit "to whichever client is currently connected" path. Use only for
genuinely host-initiated messages (welcome banner, resume notification)
where the host accepts the cross-session trade per call site.

### `replyToInbound(inbound, message): OutboundMessage`

Tag an outbound as a strict reply to a specific inbound. The HMAC-signed
correlation token rides on `metadata`, so it survives wrappers (e.g.
`createInheritedChannel`, `wrapWithFallback`) that rebuild the message
via spread, plus any clone or queue serialization that preserves the
metadata field. If the originating session has ended by the time the
tagged message is sent, it routes to `pushNotifier` instead of the
current socket. Forgery requires the per-instance HMAC secret.

## Wire format

```
client → server: {"kind":"msg","content":[{"kind":"text","text":"hi"}]}
server → client: {"kind":"msg","content":[...],"timestamp":123}
```

Internal correlation fields (`mobileSessionEpoch`, `mobileSessionMac`,
`mobileUnsolicitedMac`) are stripped from outbound metadata before the
JSON frame is serialized to the wire.
