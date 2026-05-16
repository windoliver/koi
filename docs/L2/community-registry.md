# @koi/community-registry — Community Marketplace Registry

Standalone HTTP registry for publishing, discovering, searching, and installing
Koi skills and plugins. It is designed as an opt-in marketplace service rather
than a runtime dependency, so the package is marked optional until a production
consumer wires it into a hosted deployment.

---

## Why It Exists

Skills and plugins need a shared distribution surface outside a local checkout.
This package provides the L2 registry contract for community marketplace flows:

- Validate and publish skill or plugin package metadata
- Discover featured, new, and category-filtered packages
- Search packages by name, description, tags, category, and publisher
- Resolve install candidates that match a requested Koi compatibility range
- Compute a trust score from usage, rating, publisher reputation, and findings

---

## Public API

```typescript
import {
  createCommunityRegistryService,
  createInMemoryMarketplaceBackend,
} from "@koi/community-registry";

const backend = createInMemoryMarketplaceBackend();
const service = createCommunityRegistryService({
  backend,
  authTokens: new Set(["publish-token"]),
});

const response = await service.handler(
  new Request("https://registry.example/v1/discovery?category=coding"),
);
```

The package exports request/entry types, validation helpers, trust scoring, the
in-memory backend, and the HTTP handler factory.

---

## HTTP Contract

| Route | Method | Purpose |
|---|---|---|
| `/v1/publish` | `POST` | Publish one skill or plugin version. Requires a bearer token when configured. |
| `/v1/discovery` | `GET` | Return categories, featured packages, and newest packages. |
| `/v1/search?q=...` | `GET` | Rank matching marketplace entries. |
| `/v1/packages/:kind/:name/versions` | `GET` | List versions for a package. |
| `/v1/install` | `POST` | Resolve the newest compatible package version and artifact URL. |

Duplicate publishes for the same package kind, name, and version are rejected so
existing marketplace entries cannot be silently replaced.

---

## Backend Model

`MarketplaceBackend` stores `MarketplaceEntry` records and exposes:

```typescript
interface MarketplaceBackend {
  readonly publish: (request: MarketplacePublishRequest, now?: Date) => Promise<MarketplaceEntry>;
  readonly discovery: (filter?: MarketplaceDiscoveryFilter) => Promise<MarketplaceDiscovery>;
  readonly search: (query: MarketplaceSearchQuery) => Promise<readonly MarketplaceEntry[]>;
  readonly versions: (
    kind: MarketplacePackageKind,
    name: string,
  ) => Promise<readonly MarketplaceEntry[]>;
  readonly install: (request: MarketplaceInstallRequest) => Promise<MarketplaceInstallResult>;
}
```

The in-memory backend is deterministic and intended for tests, local demos, and
future service wiring. Durable storage can implement the same contract without
changing the HTTP handler.

---

## Validation & Compatibility

Publish requests are validated with `zod` and require the metadata appropriate
for the package kind:

- `kind: "skill"` requires skill frontmatter metadata
- `kind: "plugin"` requires a plugin manifest

Install resolution honors simple semver-style Koi compatibility constraints,
including `>=`, caret ranges, and zero-major caret behavior such as `^0.0.3`.

---

## Layer & Dependencies

- **Layer**: L2
- **Imports from**: `@koi/core` (L0), `@koi/validation` (L0)
- **Status**: Optional package; no runtime consumer is wired yet

---

## Changelog

- 2026-05-16 — Initial community marketplace registry for skill/plugin publish,
  discovery, search, version listing, install resolution, and trust scoring.
