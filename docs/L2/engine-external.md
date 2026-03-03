# @koi/engine-external — External Process Engine Adapter

Wraps any external CLI process as a Koi `EngineAdapter` via `Bun.spawn()`. Designed primarily for interactive CLI agents (Claude CLI, Codex, Gemini CLI, Aider) using pseudo-terminal (PTY) mode, with fallback modes for simple scripts and structured protocols.

---

## Why It Exists

Koi agents need to orchestrate external CLI tools — research bots, code generators, domain experts — as first-class engine adapters. Without `engine-external`, each tool would need a custom engine adapter, duplicating process lifecycle, I/O parsing, timeout, and shutdown logic.

Interactive CLI agents present an additional challenge: they detect non-TTY stdin and refuse to work, emit ANSI escape sequences, and expect terminal input semantics. Piped stdin/stdout simply does not work for tools like `claude`, `codex`, or `aider`.

`@koi/engine-external` solves both problems:

1. **Unified adapter** — any CLI command becomes a Koi engine with one config object
2. **PTY mode** (default) — spawns processes in a real pseudo-terminal via `Bun.Terminal`, so interactive CLIs work natively
3. **Pluggable parsing** — output parsers transform raw stdout into `EngineEvent` streams
4. **Lifecycle management** — timeout, graceful shutdown, process tree kill, abort signal propagation

---

## Three Modes

### 1. PTY Mode (default)

For interactive CLI agents that need a real terminal. Uses `Bun.Terminal` (native PTY, zero deps, Bun >= 1.3.5) to spawn processes in a pseudo-terminal.

Turn completion is detected via hybrid idle + prompt regex:

```
PTY output ──▶ ANSI strip ──▶ Parser ──▶ EngineEvents
                    │
                    ▼
              IdleDetector
              ├── silence >= idleThresholdMs? ──▶ turn complete
              └── promptPattern matches?      ──▶ turn complete (fast path)
```

```yaml
engine:
  name: external
  options:
    command: "claude"
    args: ["--no-ui"]
    pty:
      idleThresholdMs: 10000
      promptPattern: "\\$ $"
```

### 2. Single-Shot Mode

For simple scripts and one-off commands. Spawns a new process per `stream()` call. Input is piped to stdin (then closed), process exit = done.

```yaml
engine:
  name: external
  options:
    command: "python"
    args: ["agent.py"]
    mode: "single-shot"
    timeoutMs: 30000
```

### 3. Long-Lived Mode

For structured protocols (JSON-lines, custom delimiters). Process persists across multiple `stream()` calls. The parser signals turn completion via `turnComplete: true`.

```yaml
engine:
  name: external
  options:
    command: "my-agent"
    mode: "long-lived"
    timeoutMs: 60000
```

---

## Architecture

`@koi/engine-external` is an **L2 feature package** — depends only on L0 (`@koi/core`) and L0u (`@koi/resolve`). Zero external dependencies.

```
┌──────────────────────────────────────────────────────────────┐
│  @koi/engine-external  (L2)                                  │
│                                                              │
│  adapter.ts          ← createExternalAdapter (factory)       │
│  pty-mode.ts         ← runPty generator (PTY turn lifecycle) │
│  idle-detector.ts    ← timestamp polling + prompt regex      │
│  process-manager.ts  ← spawn, stream read, graceful kill     │
│  turn-context.ts     ← shared turn lifecycle (queue/timers)  │
│  parsers.ts          ← text-delta, line, JSON-lines parsers  │
│  ansi.ts             ← ANSI escape stripping (node:util)     │
│  async-queue.ts      ← async iterable queue for events       │
│  shared-helpers.ts   ← extractInputText, trimHistory, etc.   │
│  validate-config.ts  ← config validation (Result-based)      │
│  descriptor.ts       ← BrickDescriptor for auto-resolution   │
│  env.ts              ← environment variable resolution       │
│  types.ts            ← all type definitions                  │
│                                                              │
│  Imports: @koi/core (L0), @koi/resolve (L0u)                │
└──────────────────────────────────────────────────────────────┘
```

### Process Abstraction

Piped and PTY processes are modeled as a discriminated union:

```typescript
type ManagedProcess = PipedProcess | PtyProcess;

interface PipedProcess {
  readonly kind: "piped";
  readonly stdin: { write(data: string | Uint8Array): number | Promise<number>; end(): void };
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  // ...
}

interface PtyProcess {
  readonly kind: "pty";
  readonly terminal: {
    readonly write: (data: string | Uint8Array) => number;
    readonly close: () => void;
    // ...
  };
  // ...
}
```

---

## PTY Idle Detection

The idle detector uses two complementary strategies:

| Strategy | When it fires | Use case |
|----------|--------------|----------|
| **Timestamp polling** | `Date.now() - lastOutputTime >= idleThresholdMs` | Universal fallback — works for any CLI |
| **Prompt regex** | Pattern matches end of accumulated output | Fast path — detects shell prompts like `$ ` or `>>> ` instantly |

The timestamp poll runs every 1 second by default. Prompt regex is checked synchronously on each output chunk against a 512-character sliding window — no buffering delay.

---

## Output Parsing

Three built-in parsers, or bring your own:

| Parser | Factory | Behavior |
|--------|---------|----------|
| **Text delta** | `createTextDeltaParser()` | Each stdout chunk → `text_delta` event (default) |
| **Line** | `createLineParser(handler)` | Buffers lines, calls handler per line |
| **JSON-lines** | `createJsonLinesParser()` | Parses `{"kind":"text_delta","delta":"..."}` per line |

Custom parsers implement the `OutputParser` interface:

```typescript
interface OutputParser {
  readonly parseStdout: (chunk: string) => OutputParseResult;
  readonly parseStderr: (chunk: string) => readonly EngineEvent[];
  readonly flush: () => readonly EngineEvent[];
}
```

---

## API Reference

### Factory

```typescript
function createExternalAdapter(config: ExternalAdapterConfig): ExternalEngineAdapter
```

Returns an `EngineAdapter` with additional methods:

| Method | Description |
|--------|-------------|
| `stream(input)` | Start a turn — returns `AsyncIterable<EngineEvent>` |
| `write(data)` | Write to running process stdin/terminal |
| `isRunning()` | Whether a child process is active |
| `saveState()` | Serialize output history for checkpointing |
| `loadState(state)` | Restore from checkpoint |
| `dispose()` | Kill process and clean up |

### Config

```typescript
interface ExternalAdapterConfig {
  readonly command: string;                              // required
  readonly args?: readonly string[];                     // default: []
  readonly cwd?: string;                                 // default: process.cwd()
  readonly mode?: "pty" | "single-shot" | "long-lived"; // default: "pty"
  readonly timeoutMs?: number;                           // default: 300_000 (5 min)
  readonly noOutputTimeoutMs?: number;                   // default: 0 (disabled)
  readonly maxOutputBytes?: number;                      // default: 1 MiB
  readonly pty?: PtyConfig;                              // PTY-specific settings
  readonly parser?: OutputParserFactory;                 // default: text-delta
  readonly shutdown?: ShutdownConfig;                    // graceful kill settings
  readonly env?: EnvStrategy;                            // env var strategy
}
```

### PTY Config

```typescript
interface PtyConfig {
  readonly idleThresholdMs?: number;    // default: 30_000 — silence before turn completes
  readonly ansiStrip?: boolean;         // default: true — strip escape sequences
  readonly cols?: number;               // default: 120
  readonly rows?: number;               // default: 40
  readonly promptPattern?: string;      // optional regex for fast-path detection
}
```

---

## Examples

### Minimal — wrap Claude CLI

```typescript
import { createExternalAdapter } from "@koi/engine-external";

const adapter = createExternalAdapter({
  command: "claude",
  args: ["--no-ui"],
  pty: { idleThresholdMs: 10_000 },
});

for await (const event of adapter.stream({ kind: "text", text: "explain quicksort" })) {
  if (event.kind === "text_delta") process.stdout.write(event.delta);
}

await adapter.dispose();
```

### Manifest — Codex agent with prompt detection

```yaml
name: codex-agent
version: 0.1.0
engine:
  name: external
  options:
    command: "codex"
    args: ["--quiet"]
    pty:
      idleThresholdMs: 15000
      promptPattern: "codex> $"
      cols: 200
      rows: 50
```

### Single-shot — Python script

```typescript
const adapter = createExternalAdapter({
  command: "python",
  args: ["summarize.py"],
  mode: "single-shot",
  timeoutMs: 30_000,
});

const events = [];
for await (const event of adapter.stream({ kind: "text", text: documentText })) {
  events.push(event);
}
// Process exits → done event with stopReason "completed" or "error"
```

### Long-lived — JSON-lines protocol

```typescript
import { createExternalAdapter, createJsonLinesParser } from "@koi/engine-external";

const adapter = createExternalAdapter({
  command: "my-agent",
  mode: "long-lived",
  parser: createJsonLinesParser(),
  timeoutMs: 60_000,
});

// Turn 1
for await (const event of adapter.stream({ kind: "text", text: "query 1" })) {
  // Parser signals turnComplete when it sees a complete JSON response
}

// Turn 2 — same process
for await (const event of adapter.stream({ kind: "text", text: "query 2" })) {
  // ...
}

await adapter.dispose();
```

---

## Graceful Shutdown

Process tree kill uses a three-stage strategy:

```
1. kill(-pid, SIGTERM)   ← process group signal (catches all descendants)
2. pkill -SIGTERM -P pid ← signal direct children (fallback)
3. kill(pid, SIGTERM)    ← signal the process itself
       │
       ▼
   wait gracePeriodMs (default: 5s)
       │
       ▼
   SIGKILL tree (if still alive)
```

For PTY processes, `terminal.close()` sends EOF before the signal cascade.

---

## Layer Compliance

```
@koi/core ◀── @koi/engine-external
@koi/resolve ◀─┘

No imports from @koi/engine (L1) or peer L2 packages.
Zero external npm dependencies.
```
