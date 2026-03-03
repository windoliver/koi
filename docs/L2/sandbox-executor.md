# @koi/sandbox-executor — Sandbox Executor Backends

`@koi/sandbox-executor` is an L2 package that provides sandbox execution backends for
brick verification and runtime. It offers two execution strategies — subprocess isolation
(with OS-level sandboxing) for verification, and in-process execution for promoted bricks.

---

## Why it exists

Forged bricks range from untrusted (community-authored, freshly forged) to human-approved
(promoted middleware). Running all of them in the same process with full privileges is a
security flaw. This package implements **defense in depth**: sandbox verification runs code
in an isolated subprocess, while promoted bricks run in-process for performance.

```
  Executor               Isolation level           Used for
  ────────               ───────────────           ────────
  subprocess-executor    ● Separate process        Forge verification
                         ● Restricted env vars
                         ● Network deny (Seatbelt / Bubblewrap)
                         ● Resource limits (ulimit)
                         ● Timeout + SIGKILL
                         ● 10 MB stdout cap

  promoted-executor      ● In-process import()     Runtime execution
                         ● LRU cache (256-entry)    of promoted bricks
                         ● Promise.race timeout
```

```
                           ┌──────────────────────────────┐
                           │  @koi/forge verify pipeline   │
                           │  or ForgeRuntime.resolveTool  │
                           └──────────────┬───────────────┘
                                          │
                        ┌─────────────────┼─────────────────┐
                        │                                   │
                        ▼                                   ▼
               ┌────────────────┐                  ┌────────────────┐
               │  subprocess    │                  │  promoted      │
               │  executor      │                  │  executor      │
               │  (verification)│                  │  (runtime)     │
               └────────────────┘                  └────────────────┘
               Process-level                       In-process
               isolation via                       new Function()
               Bun.spawn()                         or import()
```

---

## Architecture

### Layer position

```
L0  @koi/core                ─ SandboxExecutor, SandboxResult, SandboxError,
                               ExecutionContext, TrustTier (types only)
L2  @koi/sandbox-executor    ─ this package (no L1 dependency)
    @koi/sandbox             ─ OS-level sandbox profiles (dev dependency)
    @koi/sandbox-ipc         ─ IPC bridge to sandbox workers (dev dependency)
```

`@koi/sandbox-executor` only imports from `@koi/core` (L0) in production.
It never touches `@koi/engine` (L1) or peer L2 packages.

### Internal module map

```
index.ts                         ← public re-exports
│
├── promoted-executor.ts         ← in-process executor (new Function + import)
│
├── subprocess-executor.ts       ← child-process executor with OS isolation
├── subprocess-runner.ts         ← child process entry point (stdin/stdout JSON)
│
├── subprocess-executor.test.ts  ← subprocess isolation tests
├── promoted-executor.test.ts    ← promoted executor tests
└── __tests__/
    └── ipc-integration.test.ts  ← IPC bridge integration (gated)
```

---

## Core concepts

### Subprocess executor — process-level isolation

The subprocess executor spawns a child Bun process for each execution. This provides
five layers of isolation:

```
  ┌─────────────────────────────────────────────────────────────────┐
  │  HOST PROCESS (Koi Engine)                                      │
  │                                                                 │
  │  subprocess-executor.ts                                         │
  │  ├── buildIsolatedCommand(["bun", "run", runner.ts], context)   │
  │  ├── Bun.spawn(isolatedCmd, { stdin, stdout, stderr, env })     │
  │  ├── setTimeout → proc.kill("SIGKILL")                          │
  │  └── parse JSON from stdout → SandboxResult                    │
  │                                                                 │
  │  Five isolation layers:                                         │
  │                                                                 │
  │  1. PROCESS ISOLATION                                           │
  │     Separate memory space. Child crash ≠ host crash.            │
  │                                                                 │
  │  2. ENVIRONMENT ISOLATION                                       │
  │     Only 5 safe env vars forwarded.                             │
  │                                                                 │
  │  3. NETWORK ISOLATION (when networkAllowed=false)               │
  │     macOS: sandbox-exec / Linux: bwrap --unshare-net            │
  │                                                                 │
  │  4. RESOURCE LIMITS (when resourceLimits set)                   │
  │     ulimit -v (memory) and ulimit -u (PIDs, Linux)              │
  │                                                                 │
  │  5. OUTPUT CAP                                                  │
  │     Max 10 MB stdout.                                           │
  │                                                                 │
  └─────────────────────────────────────────────────────────────────┘
```

### Promoted executor — in-process execution

For human-approved bricks (`promoted` tier), isolation is unnecessary. The promoted
executor runs code in the host process for maximum performance:

```
  Two execution modes:

  1. import() mode (when context.entryPath is provided):
     ├── Dynamic import() with query-string cache busting
     ├── Calls default export with input
     ├── Promise.race timeout
     └── LRU cached (256 entries, keyed by entryPath)

  2. new Function() mode (fallback, no entry file):
     ├── new Function("input", code) → CompiledFn
     ├── Promise.resolve(fn(input))
     └── LRU cached (256 entries, keyed by code string)
```

---

## API reference

### Factory functions

```typescript
// Subprocess executor — spawns child Bun processes with OS isolation
createSubprocessExecutor(): SandboxExecutor

// Promoted executor — in-process new Function() / import()
createPromotedExecutor(): SandboxExecutor
```

### Types

| Type | Source | Description |
|------|--------|-------------|
| `SandboxExecutor` | `@koi/core` | Pluggable executor contract (`execute()`) |
| `SandboxResult` | `@koi/core` | `{ output, durationMs, memoryUsedBytes? }` |
| `SandboxError` | `@koi/core` | `{ code, message, durationMs }` |
| `SandboxErrorCode` | `@koi/core` | `"TIMEOUT" \| "OOM" \| "PERMISSION" \| "CRASH"` |
| `ExecutionContext` | `@koi/core` | `{ workspacePath?, entryPath?, networkAllowed?, resourceLimits? }` |
| `TrustTier` | `@koi/core` | `"sandbox" \| "verified" \| "promoted"` |
| `SandboxPlatform` | this pkg | `"seatbelt" \| "bwrap" \| "none"` |

### Utility functions

```typescript
// Detect OS sandbox capability (cached, one-time detection)
detectSandboxPlatform(): SandboxPlatform
```

---

## Examples

### Subprocess executor for verification

```typescript
import { createSubprocessExecutor } from "@koi/sandbox-executor";

const executor = createSubprocessExecutor();

const result = await executor.execute(
  "",
  { email: "test@test.com" },
  10_000,
  {
    entryPath: "/tmp/workspace/validate-email.ts",
    workspacePath: "/tmp/workspace",
    networkAllowed: false,
    resourceLimits: { maxMemoryMb: 256 },
  },
);
```

### Integration with @koi/forge

```typescript
import { createSubprocessExecutor } from "@koi/sandbox-executor";
import { createForgeRuntime, createInMemoryForgeStore } from "@koi/forge";

const executor = createSubprocessExecutor();
const store = createInMemoryForgeStore();
const runtime = createForgeRuntime({ store, executor });

const tool = await runtime.resolveTool("my-tool");
if (tool !== undefined) {
  const result = await tool.execute({ a: 40, b: 2 });
}

runtime.dispose?.();
```

---

## Platform support

| Platform | Network isolation | Memory limits | PID limits |
|----------|------------------|---------------|------------|
| macOS (Darwin) | Seatbelt (`sandbox-exec -p`) | `ulimit -v` | Not supported |
| Linux | Bubblewrap (`bwrap --unshare-net`) | `ulimit -v` | `ulimit -u` |
| Other | Fail closed (PERMISSION error) | `ulimit -v` | `ulimit -u` |

---

## Related

- [Koi Architecture](../architecture/Koi.md) — system overview and layer rules
- [@koi/forge](./forge.md) — self-extension runtime
- `@koi/sandbox` — OS-level sandbox profiles
- `@koi/core` — L0 contract definitions (`SandboxExecutor`, `ExecutionContext`)
