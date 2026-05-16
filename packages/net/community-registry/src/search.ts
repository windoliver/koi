import type { MarketplaceEntry, MarketplaceSearchQuery } from "./types.js";

function normalized(value: string): string {
  return value.toLowerCase();
}

function contains(value: string, needle: string): boolean {
  return normalized(value).includes(needle);
}

function matchesTags(entry: MarketplaceEntry, tags: readonly string[] | undefined): boolean {
  if (tags === undefined || tags.length === 0) return true;
  const entryTags = new Set((entry.tags ?? []).map((tag) => normalized(tag)));
  return tags.every((tag) => entryTags.has(normalized(tag)));
}

export function matchesMarketplaceQuery(
  entry: MarketplaceEntry,
  query: MarketplaceSearchQuery,
): boolean {
  if (query.kind !== undefined && entry.kind !== query.kind) return false;
  if (query.category !== undefined && entry.category !== query.category) return false;
  if (!matchesTags(entry, query.tags)) return false;
  if (query.q === undefined || query.q.trim().length === 0) return true;

  const needle = normalized(query.q.trim());
  return (
    contains(entry.name, needle) ||
    contains(entry.description, needle) ||
    contains(entry.publisher, needle) ||
    contains(entry.category, needle) ||
    (entry.tags ?? []).some((tag) => contains(tag, needle))
  );
}

export function computeSearchScore(entry: MarketplaceEntry, query: MarketplaceSearchQuery): number {
  if (query.q === undefined || query.q.trim().length === 0) return entry.trust;

  const needle = normalized(query.q.trim());
  const nameScore = contains(entry.name, needle) ? 60 : 0;
  const descriptionScore = contains(entry.description, needle) ? 20 : 0;
  const tagScore = (entry.tags ?? []).some((tag) => contains(tag, needle)) ? 30 : 0;
  const categoryScore = contains(entry.category, needle) ? 10 : 0;
  const publisherScore = contains(entry.publisher, needle) ? 5 : 0;

  return (
    nameScore + descriptionScore + tagScore + categoryScore + publisherScore + entry.trust / 100
  );
}
