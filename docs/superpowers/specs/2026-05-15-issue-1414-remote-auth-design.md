# Issue 1414 Remote Auth Design

## Goal

Issue 1414 adds the security layer for remote access: JWT validation, trusted
device registration and revocation, permission bridging from remote clients to
local Koi permissions, hybrid transport policy, and fail-closed transport
security checks.

## Scope

This work introduces a focused `@koi/remote` package under `packages/net/remote`.
The package owns remote-client authentication and authorization primitives, but
does not own session spawning or worktree lifecycle. Issue 1412 owns the bridge
server and session lifecycle; this package exposes small adapters that 1412 can
call once that surface is stable.

The first implementation slice is intentionally independent and testable:

- validate JWTs signed with HMAC SHA-256
- reject expired, malformed, wrong-audience, wrong-issuer, and unknown-device
  tokens
- register and revoke trusted devices in an in-memory registry
- map verified remote permission claims to local permission queries
- enforce hybrid transport policy: WebSocket is read/stream only, HTTP POST is
  write only
- reject non-loopback cleartext remote transport unless explicitly allowed for
  local development

## Non-Goals

- No remote session spawning, attach/detach, or worktree isolation. Those remain
  in issue 1412.
- No persistent trusted-device storage in this slice. The registry interface
  allows a persistent implementation later.
- No asymmetric JWT support in the first slice. The verifier is structured so
  Ed25519/JWKS can be added without changing bridge consumers.
- No gateway-http route changes until the remote bridge routes are defined by
  issue 1412.

## Architecture

`@koi/remote` is an L2 network package. It may depend on `@koi/core` and L0
utility packages, but not on `@koi/engine` or other L2 packages. It exports pure
functions and small factories:

- `jwt.ts`: parse and verify compact JWTs, including base64url, signature,
  issuer, audience, expiration, and not-before checks.
- `trusted-device.ts`: in-memory trusted-device registry with register, revoke,
  and lookup operations.
- `permission-bridge.ts`: convert verified remote permission claims into local
  `PermissionQuery` values and deny malformed claims.
- `transport-policy.ts`: classify remote operations by transport and enforce
  encryption requirements.
- `authenticator.ts`: compose JWT verification, device trust, permission mapping,
  and transport policy into a bridge-facing `authenticateRemoteRequest` function.

The bridge-facing API returns typed results rather than throwing for expected
denials. Every uncertainty is a deny: invalid JWT, expired JWT, unknown device,
revoked device, unrecognized permission claim, wrong transport, and insecure
remote transport.

## Data Flow

1. A remote client presents a Bearer JWT and device id.
2. The authenticator verifies JWT structure and signature against configured
   issuer, audience, and clock.
3. The authenticator checks that the JWT subject/device pair is trusted and not
   revoked.
4. Permission claims are mapped into local permission queries for the calling
   session or request.
5. Transport policy confirms the operation is allowed on the current transport.
6. The successful result carries `agentId`, `subject`, `deviceId`, mapped
   permission queries, and metadata for downstream bridge/session code.

## Security Decisions

- JWT verification accepts only `HS256` in this slice and rejects `none` or any
  unconfigured algorithm.
- JWT comparison uses constant-time signature comparison.
- Expiration and not-before are checked with configurable clock skew.
- Device trust is keyed by both subject and device id, so a registered device for
  one subject cannot authenticate another.
- Revocation wins over registration.
- Permission mapping is allowlist-based; unknown remote permissions deny the
  request instead of being forwarded as local authority.
- Cleartext transport is accepted only for loopback URLs or when
  `allowInsecureLocalhost` is explicitly enabled.

## References

- Claude Code bridge patterns:
  `/Users/sophiawj/private/claude-code-source-code/src/bridge/jwtUtils.ts`
- Claude Code trusted device pattern:
  `/Users/sophiawj/private/claude-code-source-code/src/bridge/trustedDevice.ts`
- Claude Code permission bridge pattern:
  `/Users/sophiawj/private/claude-code-source-code/src/remote/remotePermissionBridge.ts`
- Koi v1 JWT pattern:
  `/Users/sophiawj/private/koi/archive/v1/packages/net/channel-teams/src/verify-jwt.ts`
- Koi v1 capability and permission packages under:
  `/Users/sophiawj/private/koi/archive/v1/packages/security/`

## Testing

Tests live beside source files in `packages/net/remote/src`. Required coverage:

- valid JWT authenticates
- expired JWT rejects
- malformed JWT rejects
- unknown or revoked device rejects
- registered device authenticates
- known remote permissions map to local permission queries
- unknown remote permissions reject
- WebSocket rejects write operations
- HTTP POST rejects read/stream operations
- cleartext non-loopback transport rejects

## Rollout

The package lands as an isolated primitive package first. A follow-up patch can
wire it into the issue 1412 bridge once the bridge route and session lifecycle
shape is settled.
