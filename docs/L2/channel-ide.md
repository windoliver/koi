# @koi/channel-ide

**Layer:** L2 · **Contract:** `ChannelAdapter` (L0)

ChannelAdapter for IDE integrations (VS Code, JetBrains, etc.). Editor plugins
exchange newline-delimited JSON-RPC frames over a duplex socket. The protocol
is intentionally minimal: `notify` (server→client / client→server) carries
content blocks and metadata. No LSP — IDE plugins translate to/from native
APIs themselves.

## What it owns

- `ChannelAdapter` implementation backed by an injected duplex `IdeTransport`
- JSON-RPC frame protocol (`{ jsonrpc: "2.0", method: "notify", params: {...} }`)
- Newline-delimited framing (one frame per line)
- Capabilities declaration (`{ text: true, files: true, buttons: true }`)
- Inbound: client `notify` frames → `InboundMessage`
- Outbound: `OutboundMessage` → server `notify` frame → transport

## What it does NOT own

- Socket / TCP / pipe creation — host wires the transport
- LSP semantics (diagnostics, completions, code actions) — out of MVP scope
- Authentication, reconnection, multiplexing — transport responsibility
- File-context attachment heuristics — IDE plugin responsibility

## Dependencies

| Package | Layer | Purpose |
|---------|-------|---------|
| `@koi/core` | L0 | `ChannelAdapter`, message types |
| `@koi/channel-base` | L0u | `createChannelAdapter()` factory |

## API

### `createIdeChannel(config): ChannelAdapter`

| Field | Type | Description |
|-------|------|-------------|
| `transport` | `IdeTransport` | `{ connect, disconnect, send(line), onLine(handler) }` |
| `senderId?` | `string` | Default `"ide-user"` |

### Wire format

```
{"jsonrpc":"2.0","method":"notify","params":{"content":[{"kind":"text","text":"…"}],"senderId":"ide-user","timestamp":123}}\n
```

## Capabilities

```ts
{ text: true, files: true, buttons: true, images: false,
  audio: false, video: false, threads: false, supportsA2ui: false }
```
