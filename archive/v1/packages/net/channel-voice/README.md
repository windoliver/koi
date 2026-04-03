# @koi/channel-voice

LiveKit WebRTC + STT/TTS voice channel adapter for Koi.

Bridges real-time voice conversations into Koi's message-based channel contract. Users speak, speech is transcribed (STT), the engine processes text, and responses are synthesized back (TTS). The engine only sees `TextBlock` — voice encoding/decoding is fully internal.

## Prerequisites

| Component | Purpose | Required |
|-----------|---------|----------|
| [LiveKit Server](#self-hosted-livekit-server) | WebRTC media routing | Yes |
| [Deepgram API key](https://console.deepgram.com/) | Speech-to-text (STT) | Yes (default STT) |
| [OpenAI API key](https://platform.openai.com/) | Text-to-speech (TTS) | Yes (default TTS) |

## Quick Start

```typescript
import { createVoiceChannel } from "@koi/channel-voice";

const channel = createVoiceChannel({
  livekitUrl: "wss://livekit.yourserver.com",
  livekitApiKey: process.env.LIVEKIT_API_KEY,
  livekitApiSecret: process.env.LIVEKIT_API_SECRET,
  stt: { provider: "deepgram", apiKey: process.env.DEEPGRAM_API_KEY },
  tts: { provider: "openai", apiKey: process.env.OPENAI_API_KEY },
});

await channel.connect();

// Create a session — give these credentials to the client
const session = await channel.createSession();
// session.roomName  → "voice-1772024021299-s7xklm"
// session.token     → JWT for the client to join the room
// session.wsUrl     → "wss://livekit.yourserver.com"

// Receive transcribed speech as text
channel.onMessage(async (msg) => {
  // msg.content[0] = { kind: "text", text: "What the user said" }
  // msg.senderId   = participant ID
  // msg.threadId   = room name

  // Process through your engine, then send response back as speech
  await channel.send({
    content: [{ kind: "text", text: "Agent response here" }],
  });
});
```

## Self-Hosted LiveKit Server

LiveKit is the WebRTC infrastructure that routes audio between clients and the Koi voice adapter. You can use [LiveKit Cloud](https://cloud.livekit.io/) or self-host.

### Option A: Docker (quickest for dev/testing)

```bash
# Pull and run LiveKit server
docker run --rm \
  -p 7880:7880 \
  -p 7881:7881 \
  -p 7882:7882/udp \
  -e LIVEKIT_KEYS="devkey: secret" \
  livekit/livekit-server:latest \
  --dev

# Ports:
#   7880 — HTTP API + WebSocket signaling
#   7881 — RTC (TCP fallback)
#   7882 — RTC (UDP, primary media transport)
```

Your `.env`:

```bash
LIVEKIT_URL=ws://localhost:7880
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=secret
```

### Option B: Docker Compose (persistent)

```yaml
# docker-compose.yml
version: "3.9"
services:
  livekit:
    image: livekit/livekit-server:latest
    ports:
      - "7880:7880"
      - "7881:7881"
      - "7882:7882/udp"
    volumes:
      - ./livekit.yaml:/etc/livekit.yaml
    command: --config /etc/livekit.yaml
```

```yaml
# livekit.yaml
port: 7880
rtc:
  port_range_start: 7882
  port_range_end: 7882
  use_external_ip: false
  tcp_fallback_port: 7881
keys:
  myapikey: mysecretkey
logging:
  level: info
```

```bash
docker compose up -d
```

### Option C: Native binary

```bash
# macOS
brew install livekit

# Linux (amd64)
curl -sSL https://get.livekit.io | bash

# Start with dev mode (auto-generates keys)
livekit-server --dev

# Or with config file
livekit-server --config livekit.yaml
```

### Option D: Production (Kubernetes)

Use the official Helm chart:

```bash
helm repo add livekit https://helm.livekit.io
helm install livekit livekit/livekit-server \
  --set config.keys.myapikey=mysecretkey \
  --set config.rtc.use_external_ip=true
```

For production, you also need:

- **TLS termination** (nginx, Caddy, or cloud LB) — LiveKit requires `wss://` in production
- **TURN server** — for clients behind restrictive NATs (LiveKit has built-in TURN, or use coturn)
- **Firewall rules** — open UDP 7882 (or your configured RTC port range)

See the [LiveKit deployment docs](https://docs.livekit.io/realtime/self-hosting/deployment/) for full production guidance.

### Verifying your LiveKit server

```bash
# Install the LiveKit CLI
brew install livekit-cli   # macOS
# or: curl -sSL https://get.livekit.io/cli | bash

# Generate a test token
livekit-cli create-token \
  --api-key myapikey \
  --api-secret mysecretkey \
  --join --room test-room --identity test-user

# List rooms (should return empty array initially)
livekit-cli list-rooms \
  --url ws://localhost:7880 \
  --api-key myapikey \
  --api-secret mysecretkey
```

## STT/TTS Provider Setup

### Deepgram (STT — default)

1. Create an account at [console.deepgram.com](https://console.deepgram.com/)
2. Create an API key with "Usage" permission
3. Set `DEEPGRAM_API_KEY` in your `.env`

```typescript
stt: {
  provider: "deepgram",
  apiKey: process.env.DEEPGRAM_API_KEY,
  language: "en",       // optional, default: auto-detect
  model: "nova-2",      // optional, default: nova-2
}
```

### OpenAI (TTS — default)

1. Create an API key at [platform.openai.com](https://platform.openai.com/)
2. Set `OPENAI_API_KEY` in your `.env`

```typescript
tts: {
  provider: "openai",
  apiKey: process.env.OPENAI_API_KEY,
  voice: "alloy",       // optional: alloy, echo, fable, onyx, nova, shimmer
  model: "tts-1",       // optional: tts-1, tts-1-hd
}
```

### Alternative: OpenAI for STT, Deepgram for TTS

```typescript
stt: { provider: "openai", apiKey: process.env.OPENAI_API_KEY },
tts: { provider: "deepgram", apiKey: process.env.DEEPGRAM_API_KEY },
```

## Configuration Reference

```typescript
interface VoiceChannelConfig {
  // Required
  livekitUrl: string;           // WebSocket URL (ws:// for dev, wss:// for prod)
  livekitApiKey: string;        // LiveKit API key
  livekitApiSecret: string;     // LiveKit API secret
  stt: SttConfig;               // Speech-to-text provider
  tts: TtsConfig;               // Text-to-speech provider

  // Optional
  maxConcurrentSessions?: number;       // Default: 10
  roomEmptyTimeoutSeconds?: number;     // Default: 300 (5 min) — auto-cleanup
  debug?: boolean;                      // Default: false — includes confidence in metadata
  onHandlerError?: (err: unknown, message: InboundMessage) => void;
  queueWhenDisconnected?: boolean;      // Default: false
}
```

## Wiring with Koi Engine

Full L1 runtime integration with `createKoi` + `createPiAdapter`:

```typescript
import { createKoi } from "@koi/engine";
import { createPiAdapter } from "@koi/engine-pi";
import { createVoiceChannel } from "@koi/channel-voice";

// 1. Voice channel
const channel = createVoiceChannel({
  livekitUrl: process.env.LIVEKIT_URL,
  livekitApiKey: process.env.LIVEKIT_API_KEY,
  livekitApiSecret: process.env.LIVEKIT_API_SECRET,
  stt: { provider: "deepgram", apiKey: process.env.DEEPGRAM_API_KEY },
  tts: { provider: "openai", apiKey: process.env.OPENAI_API_KEY },
});

// 2. Engine adapter (real LLM)
const adapter = createPiAdapter({
  model: "anthropic:claude-haiku-4-5-20251001",
  systemPrompt: "You are a helpful voice assistant. Reply concisely.",
  getApiKey: async () => process.env.ANTHROPIC_API_KEY,
});

// 3. Assemble L1 runtime
const runtime = await createKoi({
  manifest: {
    name: "MyVoiceAgent",
    version: "1.0.0",
    model: { name: "anthropic:claude-haiku-4-5-20251001" },
  },
  adapter,
  channelId: "@koi/channel-voice",
  ...(channel.sendStatus !== undefined && { sendStatus: channel.sendStatus }),
});

// 4. Connect and wire
await channel.connect();
const session = await channel.createSession();

channel.onMessage(async (msg) => {
  const events = [];
  for await (const event of runtime.run({ kind: "messages", messages: [msg] })) {
    events.push(event);
  }

  // Extract text from response
  const text = events
    .filter((e) => e.kind === "text_delta")
    .map((e) => e.delta)
    .join("");

  await channel.send({ content: [{ kind: "text", text }] });
});

// Give session credentials to your client app
console.log("Join URL:", session.wsUrl);
console.log("Token:", session.token);
```

## Client-Side Integration

The client needs to join the LiveKit room using the token from `createSession()`. Use any LiveKit client SDK:

| Platform | SDK |
|----------|-----|
| Web | [@livekit/components-react](https://www.npmjs.com/package/@livekit/components-react) |
| React Native | [@livekit/react-native](https://www.npmjs.com/package/@livekit/react-native) |
| iOS | [livekit-swift](https://github.com/livekit/client-sdk-swift) |
| Android | [livekit-android](https://github.com/livekit/client-sdk-android) |
| Flutter | [livekit-flutter](https://github.com/livekit/client-sdk-flutter) |

Minimal web client example:

```typescript
import { LiveKitRoom, useVoiceAssistant } from "@livekit/components-react";

function VoiceChat({ token, wsUrl }) {
  return (
    <LiveKitRoom token={token} serverUrl={wsUrl} connect={true}>
      <VoiceAssistantUI />
    </LiveKitRoom>
  );
}
```

## Environment Variables

```bash
# .env
LIVEKIT_URL=wss://livekit.yourserver.com    # or ws://localhost:7880 for dev
LIVEKIT_API_KEY=your-api-key
LIVEKIT_API_SECRET=your-api-secret
DEEPGRAM_API_KEY=your-deepgram-key           # STT
OPENAI_API_KEY=your-openai-key               # TTS
ANTHROPIC_API_KEY=your-anthropic-key          # LLM (for engine-pi)
```

## Running Tests

```bash
# Unit tests (no API keys needed — uses mocks)
bun test packages/channel-voice/

# Manual E2E (requires ANTHROPIC_API_KEY, uses mock LiveKit pipeline)
bun run packages/channel-voice/src/__tests__/e2e-manual.ts
```

## Architecture

```
Client (browser/app)
  │  WebRTC audio
  ▼
LiveKit Server (self-hosted or cloud)
  │  Media streams
  ▼
@koi/channel-voice
  ├── pipeline.ts     STT (Deepgram) → TranscriptEvent
  ├── normalize.ts    TranscriptEvent → InboundMessage (TextBlock)
  ├── voice-channel.ts  ChannelAdapter contract
  ├── room.ts         Room CRUD, JWT tokens, session tracking
  └── config.ts       Validation, provider config
  │
  ▼
@koi/engine (L1 runtime)
  │  createKoi → middleware chain → engine adapter
  ▼
LLM (Anthropic, OpenAI, etc.)
  │  Text response
  ▼
@koi/channel-voice
  └── pipeline.speak()  → TTS (OpenAI) → audio back to client
```
