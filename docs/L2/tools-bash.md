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
  "durationMs": 42,
  "sandboxed": true
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

1. **AST-based classifier pipeline** (from `@koi/bash-ast`, PR #1660): allowlist → byte-level prefilter → tree-sitter AST walker → rule match on argv. `@koi/bash-ast` replaces the regex-only classifier previously imported from `@koi/bash-security`. Grammar-aware analysis closes regex bypasses (obfuscated backslash escapes, ANSI-C strings, line-continuation smuggling) by extracting a trustworthy `argv[]` per simple command.
2. **Two classify entry points**: when `config.elicit` is provided (TUI wiring), the tool calls `classifyBashCommandWithElicit` (async) so that `too-complex` commands route to an interactive user prompt instead of the regex fallback. When `elicit` is absent (non-interactive `koi start`, standalone tests), the sync `classifyBashCommand` with regex fallback is used instead. Closes #1634 for interactive consumers.
3. **Fail-closed on parser failure**: `parse-unavailable` (init timeout, over-length, panic) is never permissive — the tool returns `Command blocked by security policy` with `category: "injection"`. Parse-unavailable NEVER reaches the elicit callback OR the regex fallback.
4. **Hard-deny on shell-escape ambiguity**: `too-complex` reasons (`word`, `string_content`, `prefilter:line-continuation`) hard-deny regardless of path — the raw-text regex is fooled by the same escapes the walker rejects, AND a user asked about `cat \/etc\/passwd` can't reliably distinguish it from benign `cat /etc/passwd`.
5. **One-time async init**: `initializeBashAst()` is called inside `execute()` before the classifier reads the cached parser. Idempotent via cached-promise; rejection resets the cache so subsequent callers retry fresh (no permanent DoS from a transient disk error).
6. **Hardened spawn**: `bash --noprofile --norc -c "set -euo pipefail; <cmd>"`
7. **Environment isolation**: minimal env (`PATH`, `HOME`, `LANG`)
8. **AbortSignal wiring**: SIGTERM + SIGKILL escalation after grace period
9. **Output budget**: configurable `maxOutputBytes` (default 1 MB) prevents OOM
10. **Destructive-pattern defense-in-depth** (#1721): the classifier includes a `destructive` category covering catastrophic shell ops — `rm -rf` on system paths (`/`, `/etc`, `/usr`, `/bin`, etc.), `mkfs*`, `dd of=/dev/*`, fork bomb, `chmod -R 777 /`, `shutdown`/`reboot`/`halt`/`poweroff`, `init 0/6`. These fire inside `bash-tool.ts`'s execution path **after** the permission modal, so a session-wide `[a] Always allow Bash` grant does not authorize catastrophic commands. Workspace-scoped ops (`rm -rf /tmp/x`, `rm -rf node_modules`) are intentionally not caught.

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
L0u @koi/bash-ast       classifyBashCommand(), initializeBashAst() (#1660 —
                        AST-based classifier replacing the regex-only one)
L0u @koi/bash-security  BashPolicy, DEFAULT_BASH_POLICY (types + transitional
                        regex fallback consumed by @koi/bash-ast)
```

### `sandboxed` field on `BashSuccessResult`

When the Bash tool is configured with a `sandboxAdapter` (OS-level seatbelt or bwrap), the
success result includes `sandboxed: true`. This boolean is set when `sandboxAdapter` is
present in the tool config and indicates the command ran inside an OS sandbox. When the
sandbox adapter is absent, the field is omitted (not `false`). The model and downstream
consumers can use this to verify confinement status without inspecting the runtime config.

## Dependencies

```json
{
  "@koi/core": "workspace:*",
  "@koi/bash-ast": "workspace:*",
  "@koi/bash-security": "workspace:*"
}
```
