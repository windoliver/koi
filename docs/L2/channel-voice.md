# @koi/channel-voice — LiveKit WebRTC Voice Channel

Bridges real-time voice conversations into Koi's message-based channel contract using LiveKit WebRTC for audio transport, pluggable STT (Deepgram/OpenAI) for speech recognition, and pluggable TTS (OpenAI/Deepgram) for speech synthesis. The agent only sees `TextBlock` — voice encoding/decoding is fully internal.

---

## Why It Exists

Voice-powered agents need real-time audio transport, speech-to-text, text-to-speech, session management, and filler audio to prevent dead air. Without this package, every voice agent hand-wires LiveKit rooms, STT/TTS plugins, token generation, and cleanup sweeps.

`@koi/channel-voice` provides a single `createVoiceChannel()` factory that handles all of this. The agent itself never knows it's speaking — it receives and sends `TextBlock`, like any other channel.

---

## What This Enables

### Voice-Powered Agents — Transparent to the Engine

```
WITHOUT channel-voice:                    WITH channel-voice:
═══════════════════                       ══════════════════

  User types text                          User SPEAKS into mic
       │                                        │
       ▼                                        ▼
  ┌──────────┐                            ┌──────────────┐
  │  CLI /    │                            │  LiveKit     │
  │  Telegram │                            │  WebRTC      │
  │  (text)   │                            │  (audio)     │
  └─────┬─────┘                            └──────┬───────┘
        │                                         │ STT
        ▼                                         ▼
  ┌──────────┐                            ┌──────────────┐
  │  Agent   │                            │  Agent       │
  │  (text   │                            │  (same text  │
  │   in/out)│                            │   in/out!)   │
  └──────────┘                            └──────┬───────┘
                                                  │ TTS
                                                  ▼
                                          ┌──────────────┐
                                          │  Speaker     │
                                          │  (audio out) │
                                          └──────────────┘

  The agent doesn't change — it receives TextBlocks
  and sends TextBlocks, just like CLI or Telegram.
```

### Multi-Channel Agent — Voice as One Channel Among Many

```
                         ┌─────────────┐
                         │   Agent     │
                         │   Engine    │
                         └──────┬──────┘
                                │ Same OutboundMessage everywhere
                   ┌────────────┼────────────────┐
                   ▼            ▼                ▼
          ┌────────────┐ ┌────────────┐  ┌──────────────┐
          │ CLI Channel│ │ Telegram   │  │ Voice Channel│
          │            │ │ Channel    │  │              │
          │ caps:      │ │ caps:      │  │ caps:        │
          │  text ✓    │ │  text ✓    │  │  text ✓      │
          │  audio ✗   │ │  audio ✗   │  │  audio ✓     │
          └─────┬──────┘ └─────┬──────┘  └──────┬───────┘
                │              │                │
                ▼              ▼                ▼
          ┌──────────┐  ┌──────────┐    ┌──────────────┐
          │ Terminal  │  │ Telegram │    │  WebRTC      │
          │ $ text    │  │  text    │    │  🎤 → STT    │
          │ output    │  │ output   │    │  TTS → 🔊    │
          └──────────┘  └──────────┘    └──────────────┘
           reads text    reads text      HEARS speech
```

---

## Server Setup

### Prerequisites

1. **LiveKit Server** — self-hosted or [LiveKit Cloud](https://cloud.livekit.io)
2. **STT provider** — Deepgram or OpenAI API key
3. **TTS provider** — OpenAI or Deepgram API key

### 1. Install Dependencies

```bash
bun add --cwd packages/channel-voice \
  @livekit/agents@1.0.47 \
  @livekit/agents-plugin-deepgram@1.0.47 \
  @livekit/agents-plugin-openai@1.0.47 \
  livekit-server-sdk@2.15.0
```

(Already declared in `package.json` — just run `bun install`.)

### 2. Configure Environment

```bash
# .env (auto-loaded by Bun — no dotenv needed)

# LiveKit server
LIVEKIT_URL=wss://my-livekit.example.com      # ws:// for local dev, wss:// for prod
LIVEKIT_API_KEY=APIxxxxxxxxxxxxx
LIVEKIT_API_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxx

# STT provider (pick one)
DEEPGRAM_API_KEY=xxxxxxxxxxxxxxxx              # for Deepgram STT
# OPENAI_API_KEY=sk-xxxxxxxxxxxxxxx            # or for OpenAI Whisper STT

# TTS provider (pick one)
OPENAI_API_KEY=sk-xxxxxxxxxxxxxxx              # for OpenAI TTS
# DEEPGRAM_API_KEY=xxxxxxxxxxxxxxxx            # or for Deepgram TTS

# For E2E manual tests
ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxxxxx
```

### 3. Create the Voice Channel

```typescript
import { createVoiceChannel } from "@koi/channel-voice";
import type { VoiceChannelConfig } from "@koi/channel-voice";

const config: VoiceChannelConfig = {
  livekitUrl: process.env.LIVEKIT_URL!,
  livekitApiKey: process.env.LIVEKIT_API_KEY!,
  livekitApiSecret: process.env.LIVEKIT_API_SECRET!,
  stt: {
    provider: "deepgram",
    apiKey: process.env.DEEPGRAM_API_KEY!,
    model: "nova-2",           // optional — defaults to provider default
    language: "en",            // optional — auto-detect if omitted
  },
  tts: {
    provider: "openai",
    apiKey: process.env.OPENAI_API_KEY!,
    voice: "alloy",            // optional — "alloy", "echo", "fable", "onyx", "nova", "shimmer"
    model: "tts-1",            // optional — "tts-1" or "tts-1-hd"
  },
  maxConcurrentSessions: 10,   // optional — default 10
  roomEmptyTimeoutSeconds: 300, // optional — default 300 (5 min)
  debug: false,                // optional — include confidence in metadata
};

const channel = createVoiceChannel(config);
```

### 4. Wire Into the Full L1 Runtime (createKoi)

```typescript
import { createKoi } from "@koi/engine";
import { createPiAdapter } from "@koi/engine-pi";
import { createVoiceChannel } from "@koi/channel-voice";

// 1. Create voice channel
const channel = createVoiceChannel({
  livekitUrl: process.env.LIVEKIT_URL!,
  livekitApiKey: process.env.LIVEKIT_API_KEY!,
  livekitApiSecret: process.env.LIVEKIT_API_SECRET!,
  stt: { provider: "deepgram", apiKey: process.env.DEEPGRAM_API_KEY! },
  tts: { provider: "openai", apiKey: process.env.OPENAI_API_KEY! },
});

// 2. Create engine adapter (real LLM)
const adapter = createPiAdapter({
  model: "anthropic:claude-haiku-4-5-20251001",
  systemPrompt: "You are a helpful voice assistant. Reply in short sentences.",
  getApiKey: async () => process.env.ANTHROPIC_API_KEY!,
});

// 3. Assemble L1 runtime
const runtime = await createKoi({
  manifest: {
    name: "VoiceAgent",
    version: "1.0.0",
    model: { name: "anthropic:claude-haiku-4-5-20251001" },
  },
  adapter,
  channelId: "@koi/channel-voice",
  // Wire sendStatus for filler audio ("one moment..." during LLM thinking)
  ...(channel.sendStatus !== undefined && { sendStatus: channel.sendStatus }),
});

// 4. Connect and create a session
await channel.connect();
const session = await channel.createSession();

console.log("Room:", session.roomName);
console.log("Token:", session.token);       // JWT for client
console.log("WS URL:", session.wsUrl);      // LiveKit WebSocket URL

// 5. Wire inbound voice → engine → outbound voice
channel.onMessage(async (msg) => {
  // msg.content is [TextBlock] — STT already transcribed audio to text
  const events = [];
  for await (const event of runtime.run({ kind: "messages", messages: [msg] })) {
    events.push(event);
  }

  // Collect text deltas from engine response
  const responseText = events
    .filter((e) => e.kind === "text_delta")
    .map((e) => e.delta)
    .join("");

  // Send back through channel → TTS → speaker
  await channel.send({ content: [{ kind: "text", text: responseText }] });
});

// 6. Give session.token + session.wsUrl to the client
// Client joins LiveKit room with the token and speaks into mic
```

### 5. Client-Side (Browser)

The client uses [LiveKit's JavaScript SDK](https://docs.livekit.io/client-sdk-js/) to join the room:

```typescript
import { Room, Track } from "livekit-client";

const room = new Room();
await room.connect(session.wsUrl, session.token);

// Publish microphone audio
const localTrack = await room.localParticipant.setMicrophoneEnabled(true);

// Agent's TTS audio arrives as a remote audio track
room.on("trackSubscribed", (track) => {
  if (track.kind === Track.Kind.Audio) {
    const audioElement = track.attach();
    document.body.appendChild(audioElement);
  }
});
```

### 6. Local LiveKit Server (Development)

For local development without LiveKit Cloud:

```bash
# Install LiveKit CLI
brew install livekit/tap/livekit-server

# Start local LiveKit server
livekit-server --dev

# Default local config:
# URL: ws://localhost:7880
# API Key: devkey
# API Secret: secret
```

Then use `ws://localhost:7880` as `livekitUrl`.

### 7. Running the E2E Manual Test

The package includes a full E2E test that validates the complete stack with real LLM calls:

```bash
# Set API key in .env
echo "ANTHROPIC_API_KEY=sk-ant-..." >> .env

# Run the manual E2E test (uses mock LiveKit pipeline + real Anthropic)
bun run packages/channel-voice/src/__tests__/e2e-manual.ts
```

This tests:
1. Full pipeline: transcript → LLM (real Anthropic call) → `pipeline.speak()`
2. `sendStatus("processing")` → filler audio
3. Multi-turn conversation (two sequential transcripts)
4. Error handler isolation (handler throws, other handlers still receive)

---

## Architecture

`@koi/channel-voice` is an **L2 feature package** built on `@koi/channel-base`.

```
┌─────────────────────────────────────────────────────┐
│  @koi/channel-voice  (L2)                           │
│                                                     │
│  voice-channel.ts  ← createVoiceChannel() factory   │
│  pipeline.ts       ← VoicePipeline + LiveKit impl   │
│  room.ts           ← RoomManager, JWT, cleanup      │
│  normalize.ts      ← TranscriptEvent → InboundMsg   │
│  config.ts         ← validation, types, defaults    │
│  test-helpers.ts   ← mocks for testing              │
│                                                     │
├─────────────────────────────────────────────────────┤
│  External deps                                      │
│  ● @livekit/agents 1.0.47                          │
│  ● @livekit/agents-plugin-deepgram 1.0.47          │
│  ● @livekit/agents-plugin-openai 1.0.47            │
│  ● livekit-server-sdk 2.15.0                       │
│                                                     │
├─────────────────────────────────────────────────────┤
│  Internal deps                                      │
│  ● @koi/core (L0) — ChannelAdapter, InboundMessage │
│  ● @koi/channel-base (L0u) — createChannelAdapter  │
│  ● @koi/errors (L0u) — withRetry, swallowError     │
└─────────────────────────────────────────────────────┘
```

---

## End-to-End Audio Flow

### Inbound: Microphone → Agent

```
🎤 Client Microphone
   │
   │  WebRTC audio stream
   ▼
┌─────────────────────────────┐
│  LiveKit Server             │
│  (SFU media routing)        │
└──────────────┬──────────────┘
               │  audio frames
               ▼
┌─────────────────────────────┐
│  @livekit/agents            │
│  AgentSession               │
└──────────────┬──────────────┘
               │  continuous audio
               ▼
┌─────────────────────────────┐
│  STT Plugin                 │
│  (Deepgram nova-2 / OpenAI) │
│                             │
│  "Hello, can you..."        │ ← partial (ignored by normalizer)
│  "Hello, can you help me?"  │ ← isFinal: true ✓
└──────────────┬──────────────┘
               │  TranscriptEvent
               ▼
┌─────────────────────────────┐
│  normalize()                │
│  ● Only isFinal transcripts │
│  ● Skip empty/whitespace    │
│  ● Maps → InboundMessage    │
│  ● threadId = roomName      │
└──────────────┬──────────────┘
               │  InboundMessage { content: [TextBlock] }
               ▼
┌─────────────────────────────┐
│  channel.onMessage()        │
│  → Engine processes text    │
└─────────────────────────────┘
```

### Outbound: Agent → Speaker

```
┌─────────────────────────────┐
│  Engine generates response  │
│  "The capital is Paris.     │
│   It is also known as the   │
│   City of Light."           │
└──────────────┬──────────────┘
               │  channel.send({ content: [TextBlock] })
               ▼
┌─────────────────────────────┐
│  renderBlocks() (from base) │
│  Extract TextBlocks, join   │
└──────────────┬──────────────┘
               │  full text string
               ▼
┌─────────────────────────────┐
│  chunkTtsInput()            │
│  Sentence-split + merge     │
│  → ["The capital is Paris.",│
│     "It is also known as    │
│      the City of Light."]   │
└──────────────┬──────────────┘
               │  for each chunk:
               ▼
┌─────────────────────────────┐
│  withRetry(3x, 200-2000ms)  │
│  → pipeline.speak(chunk)    │
│  (repeated per chunk)       │
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────┐
│  TTS Plugin                 │
│  (OpenAI tts-1 / Deepgram)  │
│  voice: "alloy"             │
│  chunk → synthesized audio  │
└──────────────┬──────────────┘
               │  audio bytes
               ▼
┌─────────────────────────────┐
│  LiveKit Server             │
│  (WebRTC distribution)      │
└──────────────┬──────────────┘
               │  audio stream
               ▼
🔊 Client Speaker (first chunk plays immediately)
```

---

## Filler Audio — Preventing Dead Air

```
User: "What's the weather in Tokyo?"
   │
   ▼
┌──────────────────────────────────────┐
│  Engine starts processing...         │
│                                      │
│  sendStatus({ kind: "processing" })  │──▶ TTS: "One moment..."
│                                      │    🔊 plays immediately
│  ... LLM thinks (2-3 seconds) ...    │
│                                      │
│  channel.send("It's 22°C and...")    │──▶ TTS: full response
│                                      │    🔊 plays after filler
└──────────────────────────────────────┘

Without filler:                  With filler:
┌─────────────────────┐         ┌─────────────────────────┐
│ 🎤 "What's the..."  │         │ 🎤 "What's the..."      │
│                      │         │                          │
│ 🔇 ... silence ...   │ 3 sec  │ 🔊 "One moment..."      │ 0.3s
│ 🔇 ... silence ...   │         │                          │
│                      │         │ 🔊 "It's 22°C and..."   │
│ 🔊 "It's 22°C..."   │         └─────────────────────────┘
└─────────────────────┘           No awkward dead air!

Custom filler:
  sendStatus({ kind: "processing", detail: "searching" })
  → TTS speaks "searching" instead of default "one moment"
```

---

## Streaming TTS Chunking

Cuts perceived voice latency by 50-70%. Instead of waiting for the full LLM response to be synthesized as one TTS call, the text is split into sentence-level chunks and each chunk is sent to TTS independently. The first chunk starts playing while later chunks are still being synthesized.

```
WITHOUT chunking:                        WITH chunking:
══════════════════                       ═══════════════

  LLM generates full response             LLM generates full response
  "The capital of France is               "The capital of France is
   Paris. It is known as the               Paris. It is known as the
   City of Light. It has..."               City of Light. It has..."
       │                                        │
       ▼                                        ▼ chunkTtsInput()
  ┌──────────────────────┐              ┌───────────────────────┐
  │ TTS: synthesize ALL  │              │ Chunk 1: "The capital │
  │ text at once         │              │  of France is Paris." │
  │ (500ms+ before any   │              │ → TTS starts NOW      │
  │  audio plays)        │              │ → 🔊 plays at ~100ms  │
  └──────────┬───────────┘              ├───────────────────────┤
             │                          │ Chunk 2: "It is known │
             ▼                          │  as the City of Light."│
  🔊 All audio at once                 │ → TTS in parallel      │
                                        ├───────────────────────┤
                                        │ Chunk 3: "It has..."  │
                                        │ → TTS queued           │
                                        └───────────────────────┘
                                         🔊 Seamless playback
```

### How It Works

1. **Sentence segmentation** — `Intl.Segmenter` with `granularity: "sentence"` splits text at natural boundaries (periods, question marks, CJK punctuation `。？！`)
2. **Merge pass** — sentences shorter than `minChunkWords` (default: 3) are merged with the next sentence to avoid tiny audio clips
3. **Split pass** — sentences longer than `maxChunkChars` (default: 200) are split at clause boundaries (`, ; : —`) or word boundaries
4. **Per-chunk dispatch** — each chunk is sent to `pipeline.speak()` with its own `withRetry` (3x, 200-2000ms backoff)

### Configuration

```typescript
const channel = createVoiceChannel({
  // ... LiveKit + STT/TTS config ...

  // Default: chunking enabled with sensible defaults
  // (omit ttsChunking to use defaults)

  // Custom thresholds:
  ttsChunking: {
    minChunkWords: 5,    // minimum words per chunk (default: 3)
    maxChunkChars: 150,  // maximum characters per chunk (default: 200)
  },

  // Disable chunking (original single-speak behavior):
  // ttsChunking: false,
});
```

### Standalone Usage

The chunker is exported for direct use in testing or custom pipelines:

```typescript
import { chunkTtsInput } from "@koi/channel-voice";

const chunks = chunkTtsInput("Hello world. How are you today? I'm fine.", {
  minChunkWords: 3,
  maxChunkChars: 200,
});
// → ["Hello world.", "How are you today?", "I'm fine."]
```

---

## Session Lifecycle

```
Client App                  channel-voice                     LiveKit
   │                             │                              │
   │                             │  channel.connect()           │
   │                             │  → RoomManager initialized   │
   │                             │  → cleanup sweep started     │
   │                             │                              │
   │  channel.createSession()    │                              │
   │────────────────────────────▶│                              │
   │                             │  generateRoomName()          │
   │                             │  roomService.createRoom()───▶│
   │                             │  tokenGenerator.generateToken│
   │                             │  pipeline.start(roomName)    │
   │                             │                              │
   │  { roomName, token, wsUrl } │                              │
   │◀────────────────────────────│                              │
   │                             │                              │
   │  room.connect(wsUrl, token) │                              │
   │─────────────────────────────┼─────────────────────────────▶│
   │                    WebRTC negotiation                      │
   │◀────────────────────────────┼──────────────────────────────│
   │                             │                              │
   ⋮  ... voice conversation ... ⋮                              ⋮
   │                             │                              │
   │  Disconnect                 │                              │
   │                             │  channel.disconnect()        │
   │                             │  → pipeline.stop()           │
   │                             │  → roomManager.endAll()──────▶│ (rooms deleted)
   │                             │  → cleanup sweep stopped     │
```

### Cleanup Sweep (automatic stale room removal)

```
Every 60 seconds:
┌──────────────────────────────────────────────────┐
│  Room "voice-1717-abc"  created: 2 min ago       │ → keep
│  Room "voice-1717-xyz"  created: 6 min ago       │ → endSession() (> 5 min)
│  Room "voice-1717-123"  created: 30 sec ago      │ → keep
└──────────────────────────────────────────────────┘

Configurable via roomEmptyTimeoutSeconds (default: 300s / 5 min)
```

---

## STT/TTS Provider Matrix

```
╔══════════════════════════════════════════════════════════════╗
║  Pluggable STT + TTS Providers                              ║
║                                                             ║
║  STT (Speech → Text)          TTS (Text → Speech)           ║
║  ──────────────────           ──────────────────            ║
║                                                             ║
║  ┌───────────────────┐        ┌───────────────────┐        ║
║  │  Deepgram          │        │  OpenAI            │        ║
║  │  ● nova-2 (default)│        │  ● tts-1 (default) │        ║
║  │  ● language: auto  │        │  ● tts-1-hd        │        ║
║  │  ● streaming       │        │  ● 6 voices:       │        ║
║  └───────────────────┘        │    alloy, echo,    │        ║
║                                │    fable, onyx,    │        ║
║  ┌───────────────────┐        │    nova, shimmer   │        ║
║  │  OpenAI            │        └───────────────────┘        ║
║  │  ● whisper-1       │                                      ║
║  │  ● language: auto  │        ┌───────────────────┐        ║
║  └───────────────────┘        │  Deepgram          │        ║
║                                │  ● aura (default)  │        ║
║                                └───────────────────┘        ║
║                                                             ║
║  Mix & match any combination:                               ║
║    Deepgram STT + OpenAI TTS   ✓                           ║
║    OpenAI STT + Deepgram TTS   ✓                           ║
║    Deepgram STT + Deepgram TTS ✓                           ║
║    OpenAI STT + OpenAI TTS     ✓                           ║
╚══════════════════════════════════════════════════════════════╝
```

---

## Configuration Reference

### VoiceChannelConfig

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `livekitUrl` | `string` | **required** | LiveKit server URL (`ws://` dev, `wss://` prod) |
| `livekitApiKey` | `string` | **required** | LiveKit API key |
| `livekitApiSecret` | `string` | **required** | LiveKit API secret |
| `stt` | `SttConfig` | **required** | STT provider config |
| `tts` | `TtsConfig` | **required** | TTS provider config |
| `maxConcurrentSessions` | `number` | `10` | Max simultaneous voice sessions |
| `roomEmptyTimeoutSeconds` | `number` | `300` | Stale room cleanup timeout (seconds) |
| `debug` | `boolean` | `false` | Include STT confidence in metadata |
| `onHandlerError` | `function` | `undefined` | Error callback for handler exceptions |
| `queueWhenDisconnected` | `boolean` | `false` | Buffer sends while disconnected |
| `ttsChunking` | `TtsChunkingConfig \| false` | `DEFAULT_TTS_CHUNKING` | TTS chunking config. `false` to disable |

### SttConfig

| Field | Type | Options |
|-------|------|---------|
| `provider` | `string` | `"deepgram"` or `"openai"` |
| `apiKey` | `string` | Provider API key |
| `language` | `string?` | Language code (e.g., `"en"`) — omit for auto-detect |
| `model` | `string?` | Model name (e.g., `"nova-2"`, `"whisper-1"`) |

### TtsConfig

| Field | Type | Options |
|-------|------|---------|
| `provider` | `string` | `"openai"` or `"deepgram"` |
| `apiKey` | `string` | Provider API key |
| `voice` | `string?` | Voice name (e.g., `"alloy"`, `"echo"`, `"shimmer"`) |
| `model` | `string?` | Model name (e.g., `"tts-1"`, `"tts-1-hd"`) |

---

## API Reference

### Factory Functions

| Function | Returns | Purpose |
|----------|---------|---------|
| `createVoiceChannel(config, overrides?)` | `VoiceChannelAdapter` | Build voice adapter with LiveKit pipeline |
| `validateVoiceConfig(config)` | `Result<VoiceChannelConfig, KoiError>` | Validate config (never throws) |

### VoiceChannelAdapter (extends ChannelAdapter)

| Method | Returns | Purpose |
|--------|---------|---------|
| `connect()` | `Promise<void>` | Init RoomManager, start cleanup sweep |
| `disconnect()` | `Promise<void>` | Stop pipeline, end all sessions, cleanup |
| `send(message)` | `Promise<void>` | Extract text → TTS → speaker |
| `onMessage(handler)` | `() => void` | Register handler (returns unsubscribe) |
| `sendStatus(status)` | `Promise<void>` | Speak filler audio on `"processing"` |
| `createSession()` | `Promise<VoiceSession>` | Create LiveKit room + JWT token |
| `activeRoom` | `string \| undefined` | Current room name (getter) |

### VoiceSession

| Field | Type | Purpose |
|-------|------|---------|
| `roomName` | `string` | LiveKit room name |
| `token` | `string` | JWT access token for client |
| `wsUrl` | `string` | LiveKit WebSocket URL |

### Test Helpers

| Function | Returns | Purpose |
|----------|---------|---------|
| `createMockVoicePipeline()` | `MockVoicePipeline` | Mock pipeline with `.emitTranscript()` and `.mocks` |
| `createMockTranscript(text?, id?)` | `TranscriptEvent` | Factory for test transcript events |
| `createMockRoomService()` | `MockRoomService` | Mock LiveKit room API |
| `createMockTokenGenerator()` | `MockTokenGenerator` | Mock JWT generator |

### TTS Chunking

| Function / Type | Purpose |
|-----------------|---------|
| `chunkTtsInput(text, options?)` | Split text into TTS-optimized sentence chunks |
| `TtsChunkingConfig` | `{ minChunkWords?: number; maxChunkChars?: number }` |
| `ChunkTtsOptions` | Same shape as `TtsChunkingConfig` (standalone usage) |

### Constants

| Name | Value | Purpose |
|------|-------|---------|
| `DEFAULT_MAX_CONCURRENT_SESSIONS` | `10` | Default session limit |
| `DEFAULT_ROOM_EMPTY_TIMEOUT_SECONDS` | `300` | Default room cleanup timeout |
| `DEFAULT_TTS_CHUNKING` | `{ minChunkWords: 3, maxChunkChars: 200 }` | Default chunking thresholds |

---

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| VoicePipeline abstraction | Keeps LiveKit-specific code isolated; enables testing without WebRTC infra |
| Dynamic STT/TTS plugin imports | Avoids bundling unused provider plugins; load only what's configured |
| `withRetry` on `pipeline.speak()` | 3x exponential backoff (200-2000ms) handles transient TTS API failures |
| Final-only normalization | Only `isFinal: true` transcripts trigger agent turns; avoids partial speech |
| Filler audio via `sendStatus` | Speaks "one moment" (or custom) during LLM latency; prevents dead air |
| Room cleanup sweep (60s) | Removes stale rooms older than `roomEmptyTimeoutSeconds`; prevents leak |
| Immutable session tracking | RoomManager creates new Map on each mutation; safe for concurrent access |
| `@ts-expect-error` for plugins | Dynamic imports cross module boundary; type narrowing not possible |
| `Intl.Segmenter` for TTS chunking | Zero-dependency sentence splitting; handles CJK, Latin, and mixed text natively |
| Per-chunk `withRetry` | Each chunk retries independently; one transient TTS failure doesn't abort remaining chunks |
| Chunking on by default | 50-70% perceived latency reduction with no config required; `ttsChunking: false` to opt out |

---

## Layer Compliance

```
L0  @koi/core ──────────────────────────────────────────┐
    ChannelAdapter, InboundMessage, ContentBlock           │
                                                          │
L0u @koi/channel-base ──────────────────┐               │
    createChannelAdapter<TranscriptEvent> │               │
                                          │               │
L0u @koi/errors ──────────────┐          │               │
    withRetry(), swallowError()│          │               │
                               ▼          ▼               ▼
L2  @koi/channel-voice ◄──────┴──────────┴───────────────┘
    imports from L0 + L0u only
    ✗ never imports @koi/engine (L1)
    ✗ never imports peer L2 packages
    ✓ LiveKit types stay internal (never leak to public API)
```

**Dev-only:** `@koi/engine`, `@koi/engine-pi`, `@koi/test-utils` used in tests but are not runtime imports.
