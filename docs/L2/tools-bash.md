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

## Architecture

```
L2  @koi/tools-bash
  └── bash-tool.ts    createBashTool(), BashToolConfig

    depends on:
L0  @koi/core         Tool, ToolExecuteOptions, DEFAULT_UNSANDBOXED_POLICY
L0u @koi/bash-security  classifyBashCommand(), BashPolicy
```

## Dependencies

```json
{
  "@koi/core": "workspace:*",
  "@koi/bash-security": "workspace:*"
}
```
