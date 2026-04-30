# @koi/governance-scope

Capability-attenuation wrappers that bound the blast radius of a
compromised or prompt-injected tool. Each wrapper narrows an infrastructure
provider (filesystem, HTTP, credentials) to an operator-defined allowlist
and fails closed on any access outside that allowlist. Issue #1882 (gov-15).

**Scope: attenuation, not authentication.** These wrappers enforce *what*
a tool is permitted to access, not *who* the caller is. Authentication and
authorization live upstream; governance-scope enforces the resulting
capability grants at the call site.

## Surface (exact `src/index.ts` exports)

- `createScopedFs(backend, compiled): FileSystemBackend` — wraps a
  `FileSystemBackend` to enforce a glob allowlist and read-only/read-write
  mode. Path containment is enforced in two stages: (1) lexical collapse
  of `..` segments via `path.resolve`, (2) physical symlink resolution via
  `realpathSync` (walks up to nearest existing ancestor for not-yet-created
  paths). Any path that fails resolution or does not match the allowlist is
  rejected with a `PERMISSION` error. Fails closed on all resolution
  errors. Mutating operations (`write`, `delete`, `rename`, etc.) are
  rejected outright in `ro` mode regardless of scope.
- `compileScopedFs(opts): CompiledScopedFs` — pre-compiles glob strings to
  `RegExp` instances at configuration time so the hot path does no
  recompilation. Takes `{ allow: string[]; mode: "ro" | "rw" }`.
- `createScopedFetcher(inner, opts): FetchFn` — wraps a `fetch`-compatible
  function to enforce a `URLPattern[]` allowlist. Any request whose URL
  does not match at least one allowed pattern throws before the inner
  fetcher is invoked. Designed to compose with `@koi/url-safety`'s
  `createSafeFetcher` — each manual redirect hop reaches `createScopedFetcher`
  again so a redirect cannot escape the scope.
- `createScopedCredentials(component, opts): CredentialComponent` — wraps
  a `CredentialComponent` to enforce a glob allowlist of credential keys.
  Out-of-scope keys return `undefined` as if the credential does not exist
  (least-information principle — the tool cannot enumerate disallowed
  keys). Adds a `Promise.resolve()` microtask yield on the deny path to
  prevent timing-oracle leakage of allowlist membership.

## Security model

All three wrappers fail closed:

- **Filesystem**: unknown path → `PERMISSION`, not `NOT_FOUND`. A tool
  cannot distinguish "file does not exist" from "file exists but is out of
  scope."
- **Fetcher**: URL outside allowlist → thrown `Error` before any network
  activity. Matches `@koi/url-safety` convention so the two layers compose
  naturally.
- **Credentials**: unknown key → `undefined` after microtask yield. A
  tool cannot distinguish "credential not set" from "credential exists but
  is out of scope," and cannot use response latency to probe allowlist
  membership.

## Wiring

L2: depends on `@koi/core` (L0) and `@koi/url-safety` (L0u). No imports
from `@koi/engine` or peer L2 packages. Wired via CLI manifest `network:`
and `credentials:` blocks; the TUI command translates manifest config into
compiled scope objects before passing them to tool/provider factories.

## Out of scope

- Policy *authoring* (what allowlists to use) — that is an operator
  concern; this package only enforces the provided allowlist.
- Cryptographic attestation that an allowlist was not tampered with.
- Rate limiting or quota enforcement.
- Content inspection of HTTP response bodies.
- Credential rotation or expiry.

## Invariants

- Every wrapper is stateless and pure after construction; no shared mutable
  state across calls.
- Wrappers never mutate input providers or options objects.
- `compileScopedFs` is idempotent; calling it twice with the same options
  produces equivalent `CompiledScopedFs` objects.
- `createScopedCredentials` never calls the underlying component for
  out-of-scope keys (no backend leakage of denied access).
- `createScopedFetcher` never invokes the inner fetcher for blocked URLs
  (no network activity for denied requests).
- `createScopedFs` always rejects on path-resolution error rather than
  falling back to the underlying backend.
