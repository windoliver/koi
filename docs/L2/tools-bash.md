# @koi/tools-bash

L2 package — Bash shell execution tool with security classifiers.

## Purpose

Provides a `createBashTool()` factory that returns an L0 `Tool` capable of
executing bash commands. Security is enforced via `@koi/bash-security`
classifiers before every execution.

## Usage

```typescript
import { createBashTool } from "@koi/tools-bash";

const bash = createBashTool({
  workspaceRoot: process.cwd(),
  policy: {
    allowlist: ["git ", "ls", "cat ", "echo ", "bun "],
    maxOutputBytes: 512_000,
    defaultTimeoutMs: 30_000,
  },
});

// Register with your agent's tool provider
```

## Tool Schema

Input:
```json
{
  "command": "git status",
  "cwd": "./packages/my-pkg",     // optional, validated against workspaceRoot
  "timeoutMs": 10000              // optional, overrides BashPolicy.defaultTimeoutMs
}
```

Output (success):
```json
{
  "stdout": "On branch main...",
  "stderr": "",
  "exitCode": 0,
  "durationMs": 42
}
```

Output (blocked):
```json
{
  "error": "Command blocked by security policy",
  "category": "reverse-shell",
  "reason": "/dev/tcp enables raw TCP connections for reverse shells",
  "pattern": "\\/dev\\/tcp\\/"
}
```

Output (truncated):
```json
{
  "stdout": "...(first 512000 bytes)",
  "stderr": "",
  "exitCode": 0,
  "durationMs": 1234,
  "truncated": true,
  "truncatedNote": "Output truncated at 512000 bytes (1234567 bytes total)"
}
```

## Security

1. **Classifier pipeline** (from `@koi/bash-security`): allowlist → injection → path → command
2. **Hardened spawn**: `bash --noprofile --norc -c "set -euo pipefail; <cmd>"` 
3. **Environment isolation**: minimal env (`PATH`, `HOME`, `LANG`)
4. **AbortSignal wiring**: SIGTERM + SIGKILL escalation after grace period
5. **Output budget**: configurable `maxOutputBytes` (default 1 MB) prevents OOM

## OS-Level Sandboxing

This tool does NOT integrate `@koi/sandbox-os` directly (L2 cannot import L2).
For OS-level isolation (macOS seatbelt / Linux bubblewrap), wire `@koi/sandbox-os`
at the runtime assembly level via the `SandboxAdapter` component.

## Background Execution (`bash_background`)

`createBashBackgroundTool()` returns a second tool that spawns background subprocesses
tracked via a `ManagedTaskBoard` (L0 interface). The model receives a `TaskItemId`
immediately and can poll progress via `task_get` / `task_output`.

Key design points:

- **`getBoundBoard`**: optional factory called at launch time to capture the concrete
  board instance, preventing cross-session board contamination after a board rotation
  triggered by `resetSessionState()`.
- **Subprocess tracking**: `onSubprocessStart` / `onSubprocessEnd` callbacks enable
  the runtime to maintain a live subprocess count for shutdown coordination (task-board
  status alone is not a reliable proxy since `task_stop` changes board state without
  terminating the OS process).
- **Abort signal**: `getSignal` is a function (not a static signal) so the runtime
  can rotate the controller on session reset — aborting prior-session subprocesses
  while new ones receive the fresh signal.
- **Sandbox support**: accepts `sandboxAdapter` + `sandboxProfile` for OS-level
  confinement, same as the foreground tool.

## Shared Execution Layer (`exec.ts`)

Both tools share `exec.ts` for spawn/drain logic:

- `spawnBash()`: hardened process spawn with `--noprofile --norc`, process-group
  kill, SIGTERM→SIGKILL escalation after 3s grace period, safe minimal env.
- `execSandboxed()`: routes execution through a `SandboxAdapter` when provided.
- `drainStream()`: shared byte-budget-aware stream draining that prevents pipe-buffer
  deadlock by continuing to drain after budget exhaustion.

## CWD Tracking (`trackCwd`)

When `trackCwd` is enabled, a sentinel suffix (`printf '__KOI_CWD__:%s\n' "$(pwd -P)"`)
is appended to each command. On success the sentinel is parsed and stripped from stdout,
returning the resolved working directory. This allows the tool to track directory changes
across sequential Bash invocations without persisting shell state.

## OS Sandbox Integration

`BashToolConfig` now accepts `sandboxAdapter` and `sandboxProfile` fields. When
provided, all execution is transparently routed through the OS sandbox (macOS
Seatbelt / Linux bubblewrap) without exposing a separate tool to the model. The
sandbox adapter and profile are L3 server-side config — the model calls the ordinary
Bash tool and is unaware of confinement.

## Architecture

```
L2  @koi/tools-bash
  ├── bash-tool.ts              createBashTool(), BashToolConfig
  ├── bash-background-tool.ts   createBashBackgroundTool(), BashBackgroundToolConfig
  └── exec.ts                   spawnBash(), execSandboxed(), drainStream() (internal)

    depends on:
L0  @koi/core         Tool, ToolExecuteOptions, ManagedTaskBoard, SandboxAdapter,
                      DEFAULT_UNSANDBOXED_POLICY, DEFAULT_SANDBOXED_POLICY
L0u @koi/bash-security  classifyBashCommand(), BashPolicy
```

## Dependencies

```json
{
  "@koi/core": "workspace:*",
  "@koi/bash-security": "workspace:*"
}
```
