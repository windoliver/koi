# @koi/channel-voice

**Layer:** L2 · **Contract:** `ChannelAdapter` (L0)

ChannelAdapter for voice (audio in / audio out) sessions. Bridges abstract STT,
TTS, and audio-transport implementations into Koi's text-based message contract.
Vendor SDKs (LiveKit, OpenAI Realtime, Deepgram, etc.) are injected by the host —
this package is pure protocol glue.

## What it owns

- `ChannelAdapter` implementation backed by injected `VoiceTransport`, `Stt`, `Tts`
- Capabilities declaration (`{ text: true, audio: true, all else: false }`)
- Inbound: STT transcripts → `InboundMessage` with `TextBlock`
- Outbound: text blocks → TTS → audio frames → transport
- Lifecycle: open/close transport, propagate STT/TTS/transport teardown errors

## What it does NOT own

- Vendor wiring (LiveKit / Twilio / OpenAI Realtime) — host responsibility
- Audio codec selection or sample-rate conversion — transport responsibility
- TTS chunking heuristics beyond a single configurable `maxChars` boundary
- Multi-room or multi-session orchestration — host concern

## Dependencies

| Package | Layer | Purpose |
|---------|-------|---------|
| `@koi/core` | L0 | `ChannelAdapter`, message types |
| `@koi/channel-base` | L0u | `createChannelAdapter()` factory |

## API

### `createVoiceChannel(config): ChannelAdapter`

| Field | Type | Description |
|-------|------|-------------|
| `transport` | `VoiceTransport` | Audio I/O implementation (`onUtterance(handler)`, `sendUtterance(sessionId, frames)`, `connect`, `disconnect`) |
| `stt` | `Stt` | `transcribe(audio: Uint8Array): Promise<string \| null>` |
| `tts` | `Tts` | `synthesize(text: string): Promise<Uint8Array>` |
| `senderId?` | `string` | Default `"voice-user"` |
| `maxTtsChars?` | `number` | Split outbound text > N chars into multiple TTS calls. Default 240. |

### Capabilities

```ts
{ text: true, audio: true, images: false, files: false,
  buttons: false, video: false, threads: true, supportsA2ui: false }
```

## Flow

```
utterance + sessionId ──▶ transport.onUtterance ──▶ stt.transcribe ──▶ InboundMessage{TextBlock, threadId=sessionId}
OutboundMessage{threadId} ──▶ chunk(maxTtsChars) ──▶ tts.synthesize × N ──▶ transport.sendUtterance(sessionId, frames[])
non-text blocks ──▶ degraded to text by @koi/channel-base renderBlocks ──▶ TTS
```
