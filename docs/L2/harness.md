# @koi/harness

CLI harness assembly — wires a KoiRuntime to a ChannelAdapter for interactive REPL and single-prompt execution.

## Purpose

Provides `createCliHarness()`: the pure factory function that connects a pre-built engine runtime to a channel adapter and optionally a TUI. The harness manages:

- **Single-prompt mode** — send one text input, collect output, exit
- **Interactive REPL** — connect channel, loop per turn until abort or max-turns
- **Abort propagation** — `AbortSignal` threads through every engine turn for clean Ctrl+C shutdown
- **Turn-count guard** — enforces `maxTurns` before context overflow hits the model
- **TUI bridging** — `TuiAdapter | null` controls whether output goes to the rich TUI or raw stdout

The harness is the _only_ place where the runtime loop and channel I/O connect. It does not create the engine, load manifests, or compose middleware — those responsibilities stay in the L3 command layer.

## HarnessRuntime

The harness accepts any object that structurally satisfies `HarnessRuntime`, defined entirely in L0 types:

```typescript
interface HarnessRuntime {
  readonly run: (input: EngineInput) => AsyncIterable<EngineEvent>;
  readonly dispose?: () => Promise<void>;
}
```

`KoiRuntime` from `@koi/engine` satisfies this interface automatically via structural typing.

## EngineEvent Rendering

`renderEngineEvent(event, verbose)` converts a raw engine event to a human-readable string (or `null` for events that should be silent). `shouldRender(event, verbose)` gates allocation — events that would return `null` are skipped entirely to avoid unnecessary string construction.

| Event kind | verbose=false | verbose=true |
|-----------|--------------|-------------|
| `text_delta` | rendered inline | rendered inline |
| `thinking_delta` | null (silent) | rendered with `[thinking] ` prefix |
| `tool_call_start` | null | rendered as `[tool: name]` |
| `tool_call_end` | null | rendered with result summary |
| `done` | trailing newline | trailing newline |
| `plan_update` | null | rendered as `[plan] N tasks` |
| `task_progress` | null | rendered as `[task] id: status` |
| `permission_attempt` | null (silent) | null (silent) |
| all others | null | null |

`permission_attempt` events (emitted when middleware-permissions intercepts a tool call for approval) are always silent in the harness — the permission flow is handled by the runtime, not surfaced to the user as raw output.

## REPL Loop

The interactive REPL (`runInteractive`) connects the channel, then loops:

1. Wait for a user message via `channel.onMessage()`
2. Enforce `maxTurns` — if exceeded, send a "limit reached" message and stop
3. Run `runtime.run({ kind: "text", text, signal })` for one turn
4. Render events to raw-stdout (or TUI if attached)
5. Send the final `done` output back through the channel
6. Repeat until abort signal fires or the channel disconnects

A busy-guard prevents concurrent turns: if the user sends a second message while a turn is running, it is queued and processed after the current turn completes.

## Graceful Shutdown

When the provided `AbortSignal` fires (e.g. from SIGINT):
1. The signal is forwarded to `runtime.run()` via `EngineInput.signal`
2. The REPL loop exits after the current turn completes (no mid-write interruption)
3. `channel.disconnect()` is called
4. `runtime.dispose?.()` is called

Exit code 130 (SIGINT convention) is the caller's responsibility — the harness returns normally.

## API

```typescript
import {
  createCliHarness,
  renderEngineEvent,
  shouldRender,
} from "@koi/harness";

// Single-prompt
const harness = createCliHarness({
  runtime,          // KoiRuntime or any HarnessRuntime
  channel,          // ChannelAdapter (e.g. from createCliChannel())
  tui: null,        // no TUI — raw stdout fallback
  verbose: false,
  maxTurns: 100,
  signal: controller.signal,
});

const output = await harness.runSinglePrompt("list all TypeScript files");

// Interactive REPL
await harness.runInteractive();
```

## Layer

L2 — depends on `@koi/core` (L0) only.
No L1 or L2 peer imports. The engine runtime and channel are injected by the L3 command layer.
