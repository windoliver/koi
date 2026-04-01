# @koi/channel-cli

**Layer:** L2 · **Contract:** `ChannelAdapter` (L0)

ChannelAdapter for stdin/stdout terminal I/O. Thin adapter — reads user input
via readline, writes agent output to stdout, dispatches slash commands.

## What it owns

- `ChannelAdapter` implementation for local CLI (readline-based input, stdout output)
- Channel capabilities declaration (`{ text: true, all else: false }`)
- Slash command interception (lines starting with "/" dispatched to command handler)
- Tab completion for slash commands (readline native completer)
- Theme/prompt configuration (mono, dark, light presets)

## What it does NOT own

- Content block downgrade — handled by `@koi/channel-base` `renderBlocks()`
- Terminal rendering / UI components — owned by `@koi/tui`
- Command implementation / dispatch logic — owned by `@koi/cli`
- Rich rendering (markdown, code blocks, diffs) — TUI territory
- EngineEvent consumption or streaming display

## Dependencies

| Package | Layer | Purpose |
|---------|-------|---------|
| `@koi/core` | L0 | `ChannelAdapter`, `ContentBlock`, message types |
| `@koi/channel-base` | L0u | `createChannelAdapter()` factory, `renderBlocks()` |

## Architecture

```
stdin ──▶ readline ──▶ onPlatformEvent ──▶ normalize ──▶ InboundMessage
                            │
                            ▼ (if starts with "/")
                       command handler

OutboundMessage ──▶ renderBlocks() ──▶ platformSend ──▶ stdout
                                            │
                                     custom blocks ──▶ stderr
```

## API

### `createCliChannel(config?): ChannelAdapter`

Factory function returning a fully wired `ChannelAdapter`.

### `CliChannelConfig`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `input` | `NodeJS.ReadableStream` | `process.stdin` | Input stream |
| `output` | `NodeJS.WritableStream` | `process.stdout` | Output stream |
| `errorOutput` | `NodeJS.WritableStream` | `process.stderr` | Status/error stream |
| `prompt` | `string` | Theme default | Prompt string override |
| `senderId` | `string` | `"cli-user"` | Sender ID for inbound messages |
| `theme` | `CliTheme` | `"default"` | Theme preset |
| `commandHandler` | `SlashCommandHandler` | `undefined` | Slash command dispatch function |
| `completer` | `SlashCompleter` | `undefined` | Tab completion for readline (sync) |

### `CliTheme`

| Preset | Prompt | Colors |
|--------|--------|--------|
| `"default"` | `"> "` | Auto-detect TTY |
| `"mono"` | `"> "` | Disabled |
| `"dark"` | `"\x1b[36mkoi>\x1b[0m "` | Auto-detect TTY |
| `"light"` | `"\x1b[34mkoi>\x1b[0m "` | Auto-detect TTY |

### Capabilities

```typescript
{ text: true, images: false, files: false, buttons: false,
  audio: false, video: false, threads: false, supportsA2ui: false }
```

## Slash command interception

When `commandHandler` is provided, input lines starting with "/" are intercepted:
1. Line is trimmed and checked for "/" prefix
2. If match: dispatched to `commandHandler(line)`, NOT forwarded as message
3. If no match: forwarded as normal `InboundMessage`
4. When `commandHandler` is undefined: all input forwarded as messages

## Content block rendering

Handled entirely by `@koi/channel-base`:
- `ImageBlock` → `"[Image: alt]"` or `"[Image: url]"`
- `FileBlock` → `"[File: name]"` or `"[File: url]"`
- `ButtonBlock` → `"[label]"`
- `TextBlock` → passthrough to stdout
- `CustomBlock` → `"[custom: type]"` to stderr

## Testing

Uses `PassThrough` streams as mock stdin/stdout/stderr:
- No real TTY needed
- Completer tested as pure function
- Signal handling tested via readline event emission
