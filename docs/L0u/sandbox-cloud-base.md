# @koi/sandbox-cloud-base — Shared bridge and hosted-backend helpers

Small L0u package for sandbox infrastructure that needs to stay reusable across
multiple higher-layer backends.

## Layer

```
L0u @koi/sandbox-cloud-base
    depends on: @koi/core (L0)
    does NOT import: meta-stack packages, runtime routers, or peer L2 sandboxes
```

## Purpose

`@koi/sandbox-cloud-base` holds the bridge-neutral helpers shared by hosted
sandbox adapters and the new IPC bridge stack. It keeps validation and
lifecycle utilities out of backend-specific packages so L2 adapters can compose
them without pulling in each other's runtime concerns.

## Current surface

- profile validation helpers for hosted-backend capability checks
- `createCachedBridge()` for short-lived bridge lease reuse
- line reader utilities for bounded streaming reads
- output accumulator utilities for shared output capture
- destroy/cleanup guards for bridge and instance lifecycle handling

## Non-goals

- runtime routing across sandbox providers
- meta-stack assembly or dependency injection orchestration
- owning backend-specific command construction or transport logic
