# @koi/channels — Channel Adapter Registry & Stack

Manifest-driven channel resolution for Koi agents. One call wires up any combination of the built-in channel adapters (Slack, Discord, Telegram, Teams, Email, Matrix, Signal, WhatsApp, Voice, CLI, Mobile, Canvas-Fallback, Chat-SDK, AG-UI) with unified lifecycle, health checks, and ECS integration.

---

## Why It Exists

Before `@koi/channels`, wiring channel adapters into an agent required manual imports, factory calls, and lifecycle coordination for each adapter. Every consumer reimplemented the same boilerplate: look up adapter by name, validate config, create instance, build a ComponentProvider, manage disconnect.

This L3 meta-package provides:

- **Manifest-driven resolution** — declare channels in YAML, get wired adapters
- **Named registry** — look up any adapter by name (e.g., `"slack"`, `"discord"`)
- **Curated presets** — `minimal` (CLI only), `standard` (CLI + Slack + Discord + Telegram), `full` (all 14)
- **Unified lifecycle** — `dispose()` disconnects all channels; `healthCheck()` reports status across all
- **ECS integration** — auto-generates `ComponentProvider` per channel for agent assembly
- **Thin L3** — zero new logic, just registry + delegation to L2 adapters

---

## Architecture

```
┌────────────────────────────────────────────────────────────┐
│  @koi/channels  (L3)                                       │
│                                                            │
│  types.ts              ← ChannelFactory, Registry, Bundle  │
│  channel-registry.ts   ← registry + default (14 adapters)  │
│  channel-stack.ts      ← createChannelStack() main factory │
│  config-resolution.ts  ← defaults → preset → user merge    │
│  presets.ts            ← minimal / standard / full          │
│  adapters/*.ts         ← 14 thin shims (dynamic import)    │
│                                                            │
├────────────────────────────────────────────────────────────┤
│  Runtime Dependencies                                      │
│                                                            │
│  @koi/core         (L0)  ChannelAdapter, ComponentProvider │
│  @koi/channel-base (L0u) HealthStatus                      │
│                                                            │
│  L2 channel packages are devDependencies — consumers       │
│  add the ones they need to their own package.json.         │
└────────────────────────────────────────────────────────────┘
```

Adapter shims use **dynamic `import()`** so that unused channels are never loaded. This means:

- No native SDK loaded until the channel is actually requested
- No ffmpeg, no livekit, no grammy unless you configure that channel
- Bundle size stays small — `dist/index.js` is ~6.5 KB

---

## What This Feature Enables

### 1. Declarative Channel Configuration

Agents declare their channels in a manifest (YAML/JSON). The stack resolves names to adapters automatically:

```yaml
# agent manifest
channels:
  - name: slack
    options:
      botToken: ${SLACK_BOT_TOKEN}
  - name: discord
    options:
      botToken: ${DISCORD_BOT_TOKEN}
      applicationId: ${DISCORD_APP_ID}
```

### 2. One-Call Wiring

```typescript
import { createChannelStack } from "@koi/channels";

const bundle = await createChannelStack({
  channels: manifest.channels,
  connectTimeoutMs: 10_000,
});

// bundle.adapters — Map<string, ChannelAdapter>
// bundle.providers — ComponentProvider[] for ECS assembly
// bundle.healthCheck() — aggregated health across all channels
// bundle.dispose() — graceful shutdown
```

### 3. Presets for Common Deployments

```typescript
// Development — CLI only
const dev = await createChannelStack({ preset: "minimal" });

// Production — CLI + Slack + Discord + Telegram
const prod = await createChannelStack({ preset: "standard" });

// Maximum reach — all 14 adapters
const full = await createChannelStack({ preset: "full" });
```

### 4. Custom Registry

```typescript
import { createChannelRegistry, createChannelStack } from "@koi/channels";

// Register only the channels you need, or add custom adapters
const registry = createChannelRegistry(
  new Map([
    ["slack", myCustomSlackFactory],
    ["custom-sms", mySmsFactory],
  ]),
);

const bundle = await createChannelStack({ channels, registry });
```

### 5. Health Monitoring

```typescript
const health = bundle.healthCheck();
for (const [name, status] of health) {
  console.log(`${name}: ${status.healthy ? "UP" : "DOWN"} (last event: ${status.lastEventAt})`);
}
```

---

## Key Types

| Type | Purpose |
|------|---------|
| `ChannelFactory` | `(config: JsonObject, opts?) => ChannelAdapter \| Promise<ChannelAdapter>` |
| `ChannelRegistry` | Named lookup: `get(name)` + `names()` |
| `ChannelPreset` | `"minimal" \| "standard" \| "full"` |
| `ChannelStackConfig` | Input: preset, channels, registry, timeouts |
| `ChannelBundle` | Output: adapters, providers, healthCheck, dispose |
| `ChannelRuntimeOpts` | Connect/health timeout overrides |

---

## Presets

| Preset | Channels | Use case |
|--------|----------|----------|
| `minimal` | cli | Local dev, testing |
| `standard` | cli, slack, discord, telegram | Typical production |
| `full` | All 13 standalone adapters | Maximum platform reach |

---

## Config Resolution

Configuration merges in 3 layers: **defaults → preset → user overrides**.

- If `channels` is provided (non-empty), it takes priority over `preset`
- If only `preset` is provided, it expands to the preset's channel list
- If neither is provided, defaults to `minimal` (CLI only)
- `connectTimeoutMs` defaults to 30s, `healthTimeoutMs` to 5 minutes

---

## Foundation Improvements (channel-base)

This feature also hardened `@koi/channel-base` with:

| Feature | Description |
|---------|-------------|
| `connectTimeoutMs` | Per-adapter connect timeout (default 30s) |
| `maxQueueSize` | Bounded send queue with drop-oldest overflow (default 1000) |
| `onNormalizationError` | Callback for inbound message parse errors (no silent swallowing) |
| `healthCheck()` | Per-adapter health status (connected + last event timestamp) |
| `walkContentBlocks()` | DRY utility for block-type dispatching in platform-send implementations |
| Reconnection test | Contract test verifying handlers survive disconnect → connect cycles |

---

## L2 Adapter Fixes

| Fix | Adapters affected |
|-----|-------------------|
| threadId now **throws** (was silent drop) | Slack, Discord, WhatsApp, Teams, Signal |
| Error path tests added | Slack, Discord, Telegram, Email, WhatsApp, Voice |
| Mock failure modes (`failOnSend`, `throwOnConnect`) | Slack, Discord |

---

## Related

- `@koi/channel-base` — L0u foundation for all adapters
- `@koi/starter` — L3 meta-package for the full agent stack (uses similar registry pattern)
- `docs/architecture/Koi.md` — Layer definitions and anti-leak rules
