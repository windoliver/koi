# Issue 1400 Community Registry Design

## Goal

Add a standalone v2 `@koi/community-registry` service that exposes a Bun-compatible HTTP handler for publishing, discovering, searching, installing, versioning, and trust-scoring marketplace skills and plugins.

## Scope

The first v2 slice is a package-local service with an in-memory backend and clear interfaces for durable storage later. It supports skill and plugin marketplace entries, validates publish payloads with `@koi/validation`/Zod, validates skill and plugin manifests, checks compatibility before install, downloads install artifacts through an injectable `fetch`, and delegates final registration to an injectable installer callback.

Out of scope for this issue: persistent database schema, account management, payment flows, cryptographic signing, and a UI.

## Architecture

`packages/net/community-registry` is an L2 package. It depends only on L0/L0u packages, so it keeps marketplace payload validation local instead of importing peer L2 packages such as `@koi/skills-runtime` or `@koi/plugins`.

The package has four units:

- `types.ts`: public entry, backend, install, discovery, trust, and compatibility contracts.
- `validation.ts`: publish request and install request schemas plus manifest-specific validation.
- `memory-backend.ts`: deterministic in-memory backend for tests, demos, and future adapter contracts.
- `handler.ts`: route dispatch and HTTP responses.

## HTTP Surface

- `GET /v1/health` returns service health.
- `POST /v1/publish` publishes a validated skill or plugin entry. When auth tokens are configured, a Bearer token is required.
- `GET /v1/discovery` returns categories, featured entries, and newest entries.
- `GET /v1/search?q=&kind=&category=&tags=&limit=&cursor=` returns ranked full-text matches.
- `GET /v1/packages/:kind/:name` returns the newest or requested version.
- `GET /v1/packages/:kind/:name/versions` returns all versions for a package.
- `POST /v1/install` checks compatibility, downloads and validates the artifact, calls the installer callback, records the install, and returns the computed trust score.

## Data Flow

Publish accepts a `MarketplacePublishRequest`, validates common metadata, validates the embedded skill frontmatter or plugin manifest, computes trust, then stores an immutable `MarketplaceEntry`.

Search and discovery operate on backend entries. Search uses a simple weighted full-text score over name, description, tags, category, and publisher, then sorts by score, trust, and recency.

Install resolves the requested version, rejects incompatible Koi versions, downloads the artifact, verifies optional size and SHA-256 checksum, calls the configured installer, and increments downloads only after successful registration.

## Error Handling

Invalid JSON returns 400. Invalid publish or install payloads return 400. Missing auth returns 401, bad auth returns 403, missing entries return 404, incompatible versions return 409, checksum mismatch returns 422, and unexpected installer/download failures return 502. Unmatched routes return `null` so callers can compose this handler with other servers.

## Testing

Tests cover the issue acceptance bullets:

- Publish endpoint accepts valid skill/plugin entries.
- Invalid publish payloads are rejected.
- Discovery returns categorized, featured, and newest results.
- Search returns relevant matches.
- Install downloads, validates artifact size/checksum, delegates registration, and records downloads.
- Version compatibility is checked.
- Trust score combines downloads, rating, publisher reputation, and security findings.
