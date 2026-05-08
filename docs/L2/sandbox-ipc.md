# @koi/sandbox-ipc — Structured host-worker bridge

L2 package that runs untrusted code in a Bun child and moves requests/results
over a typed IPC protocol instead of stderr framing or backend-specific glue.

## Layer

```
L2  @koi/sandbox-ipc
    depends on: @koi/core (L0), @koi/sandbox-cloud-base (L0u)
    does NOT import: peer sandbox packages or engine/meta-stack layers
```

## Purpose

`@koi/sandbox-ipc` owns the structured host-worker bridge for code execution.
It exposes low-level bridge primitives for sandbox backends that want direct
control, while also adapting that bridge back into the existing
`SandboxExecutor` contract for current consumers.

## Public surface

- `createSandboxBridge(config)` builds the typed Bun-child bridge
- protocol, error, and bridge result types stay available to backend authors
- `bridgeToExecutor(config)` is the compatibility surface for
  `SandboxExecutor` consumers

## Layer cleanliness

The package does not know how to wrap Bun with Docker, SSH, Seatbelt, Bubblewrap,
or any other backend-specific launcher. Instead it accepts an injected command
builder, which keeps `@koi/sandbox-ipc` layer-clean and reusable across multiple
sandbox implementations.

## Notes

- bridge errors are translated into `SandboxError` codes at the adapter edge
- `bridgeToExecutor()` reuses `createSandboxBridge()` rather than forking a
  second execution path
