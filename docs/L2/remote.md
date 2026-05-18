# @koi/remote

**Layer:** L2
**Package:** `packages/net/remote`
**Issue:** #1414

Remote-client authentication and authorization primitives for bridge-facing
code. This package is intentionally isolated until issue #1412 wires the remote
bridge routes and session lifecycle.

## What it owns

- HS256 compact JWT verification for remote clients
- Registered-claim checks for issuer, audience, expiration, and not-before
- Subject and device-id extraction from verified JWTs
- In-memory trusted-device registration, lookup, and revocation
- Remote permission claim mapping to local `PermissionQuery` objects
- Hybrid transport policy:
  - WebSocket for read and stream operations
  - HTTP POST for write operations
- Fail-closed transport checks for insecure non-loopback URLs
- A composed `authenticateRemoteRequest()` helper for bridge adapters

## What it does NOT own

- Remote bridge HTTP or WebSocket routes
- Session spawning, attach, detach, or worktree lifecycle
- Persistent trusted-device storage
- Asymmetric JWT or JWKS validation
- Gateway route changes

## Dependencies

| Package | Layer | Purpose |
|---------|-------|---------|
| `@koi/core` | L0 | `PermissionQuery` contract for mapped remote authority |

## API

### `verifyRemoteJwt(token, options)`

Verifies a compact JWT signed with HS256 and returns typed deny reasons instead
of throwing for expected failures. The verifier rejects malformed tokens,
unsupported algorithms, invalid signatures, expired tokens, invalid issuer or
audience values, missing subject/device claims, and malformed present
permission claims.

### `createInMemoryTrustedDeviceRegistry()`

Creates a subject-and-device keyed registry with `register`, `revoke`, `lookup`,
and `isTrusted` operations. Revocation wins over later registration for the same
subject/device pair.

### `mapRemotePermissions(claims, mappings)`

Maps allowlisted remote permission strings into local `PermissionQuery` values.
Unknown remote permissions reject the request rather than being forwarded as
local authority.

### `enforceRemoteTransportPolicy(input)`

Validates that the operation is allowed on the selected transport and that the
URL uses the expected secure scheme. Cleartext loopback URLs require explicit
`allowInsecureLocalhost` opt-in.

### `authenticateRemoteRequest(request, options)`

Composes JWT verification, trusted-device lookup, permission mapping, and
transport policy into one bridge-facing authentication result.
