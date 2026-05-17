# @koi/middleware-sandbox

L2 middleware package - Fail-closed ToolPolicy.sandbox enforcement for sandboxed
tool execution.

## Purpose

`@koi/middleware-sandbox` protects hosts that mark tools with
`ToolPolicy.sandbox: true`. It prevents sandbox-required tools from being
presented to the model or executed directly unless the host has explicitly
attached an executor, or has attested that a provider-enforced sandbox boundary
backs the concrete tool policy.

The package is intentionally small and intercept-only. It does not create a
sandbox process or broker tool calls itself; it enforces the contract between
tool policy metadata and whichever runtime component supplies sandboxed
execution.

## API

```typescript
import { createSandboxEnforcementMiddleware } from "@koi/middleware-sandbox";

const middleware = createSandboxEnforcementMiddleware({
  required: true,
  sandboxBackedTools: ["bash"],
  policies: {
    bash: { sandbox: true, capabilities: {} },
  },
});
```

`createSandboxEnforcementMiddleware()` returns a `KoiMiddleware` named
`koi:sandbox-enforcement` with priority `90` in the `intercept` phase. It wraps:

- `wrapModelCall` and `wrapModelStream` to filter unsafe sandbox-required tools
  out of model context.
- `wrapToolCall` to fail closed before a sandbox-required tool can execute
  without a trusted sandbox backing.
- `describeCapabilities` to expose whether the middleware is in warn-only,
  fail-closed, or executor-backed mode.

## Enforcement Modes

### Required mode

When `required: true`, a tool with `ToolPolicy.sandbox: true` must be backed by
one of the configured trust mechanisms. Otherwise:

- model calls and streaming model calls omit that tool from the visible tool
  list;
- direct tool calls throw a non-retryable `PERMISSION` `KoiRuntimeError`;
- warning observers are notified for filtered model context.

### Warn-only mode

When `required` is omitted or false, direct sandbox-required tool calls are
allowed through, but the middleware emits a warning. Model context is left
unchanged so local runtimes that have not opted into strict enforcement keep
their existing behavior.

### Executor-backed tools

Use `sandboxBackedTools` or `isSandboxBacked(toolId)` when the host has routed
specific tools through a sandbox executor:

```typescript
createSandboxEnforcementMiddleware({
  required: true,
  sandboxBackedTools: ["bash", "python"],
  policies,
});
```

Trust is scoped by tool id. Backing one tool does not make other
sandbox-required tools safe.

### Provider-backed tools

Provider-backed sandboxing requires explicit host attestation with the actual
policy object:

```typescript
createSandboxEnforcementMiddleware({
  required: true,
  isProviderSandboxBacked: (toolId, policy) =>
    toolId === "web_search" && policy.sandboxBacking === "provider",
  policies,
});
```

This keeps provider trust bound to the concrete component instead of trusting a
spoofable tool name alone.

## Architecture

```
L2 @koi/middleware-sandbox
  imports:
    @koi/core    KoiMiddleware, model/tool request types, ToolPolicy
    @koi/errors  KoiRuntimeError

  src/index.ts
    createSandboxEnforcementMiddleware()
    filterTools()
    wrapModelCall()
    wrapModelStream()
    wrapToolCall()
```

The enforcement decision is:

1. If a tool has no policy or `sandbox !== true`, allow it.
2. If `sandboxBacking === "provider"`, require
   `isProviderSandboxBacked(toolId, policy)`.
3. Otherwise require `isSandboxBacked(toolId)`.
4. If the requirement is not satisfied, warn, filter, or throw according to the
   configured enforcement mode.

Observer hooks are isolated: exceptions thrown by `onWarning` are swallowed so
telemetry cannot weaken enforcement.

## Security Notes

- Enforcement is fail-closed for direct calls in required mode.
- Unknown-policy tools are not treated as sandbox-required; hosts must attach
  `ToolPolicy.sandbox: true` to tools that need the boundary.
- Provider-backed sandboxing is opt-in per tool and per policy object.
- The deprecated `executorConfigured` flag remains accepted for compatibility,
  but new integrations should use `sandboxBackedTools` or `isSandboxBacked`.

## Tests

The package test suite covers:

- fail-closed `PERMISSION` errors for unbacked sandbox-required tools;
- warn-only direct calls;
- model-call and streaming-tool filtering;
- executor backing scoped to specific tools;
- provider-backed tools rejected unless the host explicitly trusts the policy.
