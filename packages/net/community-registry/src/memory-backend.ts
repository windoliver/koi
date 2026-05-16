import { computeSearchScore, matchesMarketplaceQuery } from "./search.js";
import { computeMarketplaceTrustScore } from "./trust.js";
import type {
  CommunityRegistryBackend,
  MarketplaceDiscovery,
  MarketplaceEntry,
  MarketplacePublishRequest,
  MarketplaceSearchPage,
  MarketplaceSearchQuery,
  MarketplaceVersionPage,
} from "./types.js";
import { validatePublishRequest } from "./validation.js";

function entryKey(kind: string, name: string, version: string): string {
  return `${kind}:${name}:${version}`;
}

function comparePublishedDesc(left: MarketplaceEntry, right: MarketplaceEntry): number {
  return right.publishedAt.localeCompare(left.publishedAt);
}

function compareVersionDesc(left: MarketplaceEntry, right: MarketplaceEntry): number {
  return right.version.localeCompare(left.version, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function paginate(
  items: readonly MarketplaceEntry[],
  query: MarketplaceSearchQuery,
): MarketplaceSearchPage {
  const offset = query.cursor !== undefined ? Number(query.cursor) : 0;
  const safeOffset = Number.isFinite(offset) && offset > 0 ? offset : 0;
  const limit = query.limit ?? 25;
  const pageItems = items.slice(safeOffset, safeOffset + limit);
  const nextOffset = safeOffset + pageItems.length;
  return {
    items: pageItems,
    total: items.length,
    nextCursor: nextOffset < items.length ? String(nextOffset) : null,
  };
}

function mapToEntry(
  request: MarketplacePublishRequest,
  now: Date,
  downloads = 0,
): MarketplaceEntry {
  const timestamp = now.toISOString();
  const trust = computeMarketplaceTrustScore({
    downloads,
    rating: request.rating,
    publisherReputation: request.publisherReputation,
    securityFindings: request.securityFindings,
  });

  return {
    ...request,
    id: entryKey(request.kind, request.name, request.version),
    publishedAt: timestamp,
    updatedAt: timestamp,
    downloads,
    trust,
  };
}

function createDiscovery(
  entries: readonly MarketplaceEntry[],
  category?: string,
): MarketplaceDiscovery {
  const filtered =
    category === undefined ? entries : entries.filter((entry) => entry.category === category);
  const categories = [...new Set(entries.map((entry) => entry.category))]
    .map((entryCategory) => ({
      category: entryCategory,
      count: entries.filter((entry) => entry.category === entryCategory).length,
    }))
    .filter((item) => category === undefined || item.category === category)
    .sort((left, right) => left.category.localeCompare(right.category));

  return {
    categories,
    featured: filtered
      .filter((entry) => entry.featured === true)
      .sort((left, right) => right.trust - left.trust || comparePublishedDesc(left, right))
      .slice(0, 10),
    newest: [...filtered].sort(comparePublishedDesc).slice(0, 10),
  };
}

class InMemoryCommunityRegistryBackend implements CommunityRegistryBackend {
  private entries = new Map<string, MarketplaceEntry>();

  constructor(initialEntries: readonly MarketplacePublishRequest[]) {
    for (const request of initialEntries) {
      const entry = mapToEntry(validatePublishRequest(request), new Date());
      this.upsert(entry);
    }
  }

  async publish(request: MarketplacePublishRequest, now = new Date()): Promise<MarketplaceEntry> {
    const validated = validatePublishRequest(request);
    const entry = mapToEntry(validated, now);
    if (this.entries.has(entry.id)) {
      throw new Error(`${entry.kind} ${entry.name}@${entry.version} already exists`);
    }
    this.upsert(entry);
    return entry;
  }

  async get(
    kind: MarketplaceEntry["kind"],
    name: string,
    version?: string,
  ): Promise<MarketplaceEntry | null> {
    const matches = [...this.entries.values()]
      .filter(
        (entry) =>
          entry.kind === kind &&
          entry.name === name &&
          (version === undefined || entry.version === version),
      )
      .sort(compareVersionDesc);
    return matches[0] ?? null;
  }

  async versions(
    kind: MarketplaceEntry["kind"],
    name: string,
  ): Promise<MarketplaceVersionPage["items"]> {
    return [...this.entries.values()]
      .filter((entry) => entry.kind === kind && entry.name === name)
      .sort(compareVersionDesc);
  }

  async search(query: MarketplaceSearchQuery): Promise<MarketplaceSearchPage> {
    const matches = [...this.entries.values()]
      .filter((entry) => matchesMarketplaceQuery(entry, query))
      .sort(
        (left, right) =>
          computeSearchScore(right, query) - computeSearchScore(left, query) ||
          right.trust - left.trust ||
          comparePublishedDesc(left, right),
      );
    return paginate(matches, query);
  }

  async discovery(
    query: { readonly category?: string | undefined } = {},
  ): Promise<MarketplaceDiscovery> {
    return createDiscovery([...this.entries.values()], query.category);
  }

  async recordInstall(
    kind: MarketplaceEntry["kind"],
    name: string,
    version: string,
  ): Promise<MarketplaceEntry | null> {
    const existing = await this.get(kind, name, version);
    if (existing === null) return null;
    const downloads = existing.downloads + 1;
    const updated: MarketplaceEntry = {
      ...existing,
      downloads,
      trust: computeMarketplaceTrustScore({
        downloads,
        rating: existing.rating,
        publisherReputation: existing.publisherReputation,
        securityFindings: existing.securityFindings,
      }),
      updatedAt: new Date().toISOString(),
    };
    this.upsert(updated);
    return updated;
  }

  private upsert(entry: MarketplaceEntry): void {
    this.entries = new Map([...this.entries, [entry.id, entry]]);
  }
}

export function createInMemoryCommunityRegistryBackend(
  initialEntries: readonly MarketplacePublishRequest[] = [],
): CommunityRegistryBackend {
  return new InMemoryCommunityRegistryBackend(initialEntries);
}
