# Channel Lazy Loading — Dynamic Descriptor Discovery + Multi-Channel Wiring

How channel adapters (Slack, Discord, Telegram, etc.) are discovered at startup and wired into the CLI runtime without static imports.

## Overview

Channel adapters are L2 packages with heavy dependencies (`discord.js`, LiveKit SDKs, Baileys). Static imports would pull all of them into the CLI bundle even when unused. Lazy loading solves this: descriptors are discovered at startup via dynamic `import()`, and only the channels declared in `koi.yaml` are instantiated.

```
  koi.yaml                 resolve-agent           CLI (start/serve)
  ┌──────────┐   load      ┌────────────────┐      ┌────────────────────┐
  │ channels:│──────────>  │ 1. static desc │      │ for each channel:  │
  │  - slack │  manifest   │ 2. discover()  │      │   ch.connect()     │
  │  - discord            │ 3. merge+dedup │      │   ch.onMessage()───┼──> engine
  └──────────┘             │ 4. resolve     │      │   ch.send() <──────┤
                           └───────┬────────┘      └────────────────────┘
                                   │
                                   ▼
                           ResolvedManifest
                           { channels: [SlackAdapter, DiscordAdapter] }
```

---

## The Three Gaps (Before)

```
  resolve-agent.ts         start.ts                serve.ts
  ┌──────────────────┐     ┌──────────────────┐    ┌──────────────────┐
  │ ALL_DESCRIPTORS: │     │ channel =        │    │ (no channel      │
  │   middleware  [17]│     │   createCliChannel│    │  wiring at all)  │
  │   model       [3]│     │   ()  ← hardcoded│    │                  │
  │   engine      [1]│     │                  │    │                  │
  │   channel     [0]│ ←── │ ignores resolved │    │                  │
  │             ^^^^^ │     │   .channels      │    │                  │
  └──────────────────┘     └──────────────────┘    └──────────────────┘
       gap #1                   gap #2                  gap #3
```

1. `resolve-agent.ts` registered zero channel descriptors — manifests with `channels:` fail
2. `start.ts` hardcoded `createCliChannel()` and ignored `resolved.value.channels`
3. `serve.ts` had no channel wiring at all

---

## The Fix (After)

```
  resolve-agent.ts         start.ts                serve.ts
  ┌──────────────────┐     ┌──────────────────┐    ┌──────────────────┐
  │ ALL_DESCRIPTORS: │     │ channels =       │    │ channels =       │
  │   middleware  [17]│     │   resolved       │    │   resolved       │
  │   model       [3]│     │     .channels    │    │     .channels    │
  │   engine      [1]│     │   ?? [cliChannel]│    │   ?? []          │
  │                  │     │                  │    │                  │
  │ + discover()     │     │ for each ch:     │    │ for each ch:     │
  │   channel-slack  │     │   ch.connect()   │    │   ch.connect()   │
  │   channel-discord│     │   ch.onMessage() │    │   ch.onMessage() │
  │   channel-*      │     │   ch.disconnect()│    │   ch.send()      │
  └──────────────────┘     └──────────────────┘    └──────────────────┘
       fixed #1                 fixed #2                fixed #3
```

---

## Discovery Flow

### How `discoverDescriptors()` works

```
  packages/                        discoverDescriptors(packagesDir)
  ├── channel-slack/                      │
  │   └── dist/index.js ─────────────────>│  import() → check descriptor export
  ├── channel-discord/                    │  import() → check descriptor export
  │   └── dist/index.js ─────────────────>│
  ├── channel-cli/                        │  import() → check descriptor export
  │   └── dist/index.js ─────────────────>│
  ├── middleware-ace/                      │  import() → already in static list → deduped
  │   └── dist/index.js ─────────────────>│
  ├── middleware-guardrails/              │  in SKIP_LIST → skipped
  ├── core/                               │  no prefix match → skipped
  └── engine-loop/                        │  no dist/index.js → skipped
                                          │
                                          ▼
                                   Result<BrickDescriptor[]>
```

### Prefix matching

Only directories matching these prefixes are scanned:

```
  DISCOVERABLE_PREFIXES = ["middleware-", "channel-", "engine-"]
```

### Deduplication

```
  Static descriptors (ALL_DESCRIPTORS)     Discovered descriptors
  ┌──────────────────────────────┐         ┌──────────────────────┐
  │ middleware:ace               │         │ middleware:ace        │ ← collision
  │ middleware:audit             │         │ channel:slack         │ ← new
  │ middleware:pii               │         │ channel:discord       │ ← new
  │ model:anthropic              │         │ channel:cli           │ ← new
  │ engine:@koi/engine-external  │         └──────────────────────┘
  └──────────────────────────────┘
                     │                               │
                     └──────────┬────────────────────┘
                                │  merge: static wins
                                ▼
                     ┌──────────────────────────────┐
                     │ middleware:ace     (static)   │
                     │ middleware:audit   (static)   │
                     │ middleware:pii     (static)   │
                     │ model:anthropic    (static)   │
                     │ engine:external    (static)   │
                     │ channel:slack      (discovered)│
                     │ channel:discord    (discovered)│
                     │ channel:cli        (discovered)│
                     └──────────────────────────────┘
```

---

## Channel Wiring

### `koi start` — interactive mode

```
  koi.yaml declares channels?
       │
       ├── YES: channels = resolved.value.channels
       │         (Slack, Discord, Telegram, etc.)
       │
       └── NO:  channels = [createCliChannel()]
                (backward compatible — stdin/stdout)

  for each channel:
       │
       ├── ch.connect()         establish connection
       │
       ├── ch.onMessage(...)    subscribe to inbound messages
       │         │
       │         ▼
       │   ┌─────────────────┐
       │   │ extract text    │
       │   │ guard: empty?   │──→ skip
       │   │ guard: busy?    │──→ "(busy — please wait)"
       │   │ engine.run()    │──→ renderEvent() → stdout
       │   └─────────────────┘
       │
       └── ch.disconnect()      on shutdown
```

### `koi serve` — headless mode

```
  koi.yaml declares channels?
       │
       ├── YES: channels = resolved.value.channels
       │
       └── NO:  channels = []
                (empty — headless, no I/O)

  for each channel:    ← 1:1 per-channel handler
       │
       ├── ch.connect()
       │
       ├── ch.onMessage(...)
       │         │
       │         ▼
       │   ┌─────────────────────────┐
       │   │ extract text            │
       │   │ guard: empty? → skip    │
       │   │ engine.run()            │
       │   │ collect text_delta →    │
       │   │   ContentBlock[]        │
       │   │ ch.send({ content })    │──→ response goes back through
       │   │                         │    SAME channel it came from
       │   └─────────────────────────┘
       │
       └── ch.disconnect()      in onCleanup
```

### 1:1 routing (serve.ts)

Each channel's `onMessage` handler captures the channel in a closure. Responses always route back to the originating channel:

```
  ┌──────────┐   "hello"    ┌──────────┐   run()    ┌──────────┐
  │  Slack   │──onMessage──>│  Engine  │──stream──>│ Response │
  │  channel │              │          │           │ blocks   │
  │          │<──ch.send()──│          │<──────────│          │
  └──────────┘              └──────────┘           └──────────┘

  ┌──────────┐   "hey"      ┌──────────┐   run()    ┌──────────┐
  │ Discord  │──onMessage──>│  Engine  │──stream──>│ Response │
  │  channel │              │          │           │ blocks   │
  │          │<──ch.send()──│          │<──────────│          │
  └──────────┘              └──────────┘           └──────────┘

  Each channel gets its own handler closure — no routing table needed.
```

---

## Graceful Degradation

```
  discoverDescriptors()
       │
       ├── OK: merge discovered + static descriptors
       │
       └── ERROR (e.g., packages dir missing):
             │
             ├── stderr: "warn: descriptor discovery failed: ..."
             └── continue with static descriptors only
                 (all existing middleware/model/engine still work)
```

Discovery never blocks resolution. A broken channel package (missing `dist/index.js`, no `descriptor` export, invalid descriptor shape) is silently skipped — other packages still load.

---

## Backward Compatibility

| Scenario | Before | After |
|---|---|---|
| No `channels:` in manifest + `koi start` | CLI channel | CLI channel (identical) |
| No `channels:` in manifest + `koi serve` | No channels | No channels (identical) |
| `channels: [{name: "slack"}]` + `koi start` | NOT_FOUND error | Resolves Slack adapter |
| New middleware package added to `packages/` | Requires static import | Auto-discovered |

---

## Files

| File | Role |
|---|---|
| `packages/resolve/src/discover.ts` | `discoverDescriptors()` — scans packages dir |
| `packages/cli/src/resolve-agent.ts` | Merges static + discovered descriptors |
| `packages/cli/src/commands/start.ts` | Multi-channel wiring with CLI fallback |
| `packages/cli/src/commands/serve.ts` | Multi-channel wiring with 1:1 routing |
| `packages/resolve/src/resolve-channels.ts` | Parallel channel resolution from registry |

---

## Adding a New Channel

To add a new channel adapter that participates in lazy loading:

1. Create `packages/channel-<name>/` with a `BrickDescriptor` export:

   ```typescript
   // packages/channel-livekit/src/index.ts
   import type { BrickDescriptor } from "@koi/resolve";
   import type { ChannelAdapter } from "@koi/core";

   export const descriptor: BrickDescriptor<ChannelAdapter> = {
     kind: "channel",
     name: "livekit",
     optionsValidator: (input) => validateLiveKitConfig(input),
     factory: (options, context) => createLiveKitChannel(options),
   };
   ```

2. Build the package: `bun run build --filter '@koi/channel-livekit'`

3. Use in manifest:

   ```yaml
   # koi.yaml
   channels:
     - name: livekit
       options:
         room: my-room
         token: ${LIVEKIT_TOKEN}
   ```

That's it. No changes to `resolve-agent.ts` or any CLI code. The descriptor is discovered automatically at startup.

---

## Related

- [Manifest Resolution](./architecture/manifest-resolution.md) — full resolution pipeline
- [Channel Base](./L2/channel-base.md) — shared channel adapter factory
- [Brick Auto-Discovery](./architecture/brick-auto-discovery.md) — runtime discovery (forge pipeline)
- `packages/resolve/src/discover.test.ts` — 7 test cases for discovery
