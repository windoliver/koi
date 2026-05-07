# @koi/channel-fallback

**Layer:** L2 · **Contract:** `ChannelAdapter` (L0)

Decorator that wraps any `ChannelAdapter` and downgrades unsupported content
blocks to text **before** they reach the underlying adapter. Use for narrow
channels (SMS, voice) that cannot render rich blocks but should still receive
a useful textual representation.

## What it owns

- `wrapWithFallback(inner, opts?)` decorator returning a new `ChannelAdapter`
- Block-by-block downgrade rules driven by the inner channel's capabilities
- Optional fallback URL prefix for hosted artifact links

## What it does NOT own

- The block rendering done by `@koi/channel-base/renderBlocks` — that runs
  inside the inner adapter's `send`. This wrapper runs *first* so unsupported
  blocks become `TextBlock`s before downstream rendering.
- Hosting / serving the artifact URLs (host responsibility)
- A2UI surface generation — out of MVP scope

## Dependencies

| Package | Layer | Purpose |
|---------|-------|---------|
| `@koi/core` | L0 | `ChannelAdapter`, message types |
| `@koi/channel-base` | L0u | (transitive — type re-exports only) |

## API

### `wrapWithFallback(inner, opts?): ChannelAdapter`

Returns a new `ChannelAdapter` that delegates `connect`/`disconnect`/`onMessage`
to `inner` unchanged, and rewrites `send`'s `content` per the rules below.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `urlPrefix` | `string` | `""` | Prepended to file/image URLs in fallback text |
| `dropCustom` | `boolean` | `false` | If `true`, drop `CustomBlock` instead of degrading to `[custom: type]` |

## Downgrade rules

| Block | Inner supports? | Pass through | Otherwise downgrade to |
|-------|------------------|--------------|------------------------|
| `TextBlock` | always | yes | n/a |
| `ImageBlock` | `images` | yes | `[image: <alt or url>](<urlPrefix><url>)` |
| `FileBlock` | `files` | yes | `[file: <name or url>](<urlPrefix><url>)` |
| `ButtonBlock` | `buttons` | yes | `[<label>]` |
| `CustomBlock` | `supportsA2ui` | yes | `[custom: <type>]` (or dropped if `dropCustom`) |
