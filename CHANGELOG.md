# Changelog

## v2.0.0 (unreleased)

### Breaking Changes

- Archived 230 v1 packages to `archive/v1/`. Only the kernel (L0 + L1) and 11 L0u utilities remain.
- Removed `tests/e2e` and `recipes/*` workspaces.

### What's Retained

- **L0**: `@koi/core` — interfaces-only kernel
- **L1**: `@koi/engine`, `@koi/engine-compose`, `@koi/engine-reconcile` — kernel runtime
- **L0u** (11 packages): `@koi/edit-match`, `@koi/errors`, `@koi/event-delivery`, `@koi/execution-context`, `@koi/file-resolution`, `@koi/git-utils`, `@koi/hash`, `@koi/session-repair`, `@koi/shutdown`, `@koi/token-estimator`, `@koi/validation`

### New CI Guards

- `check:doc-gate` — every active L2 package must have `docs/L2/<name>.md`
- `check:test-integrity` — prevents test deletion/weakening in PRs
- `check:complexity` — enforces < 400 lines/file, < 50 lines/function
