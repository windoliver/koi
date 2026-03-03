/**
 * Index source — delegates search to a Retriever<T> backend.
 *
 * Thin adapter that transforms Retriever results into ParsedDocument[].
 * The actual search implementation lives in the backend (e.g., SQLite FTS,
 * vector store).
 */

import type { IndexSourceConfig, ParsedDocument, ScanResult } from "./types.js";

/**
 * Query an index backend and return results as ParsedDocuments.
 *
 * Uses the Retriever's `retrieve()` method to fetch documents,
 * then maps them to the internal ParsedDocument format.
 */
export async function scanIndex(config: IndexSourceConfig, maxDocs: number): Promise<ScanResult> {
  const result = await config.backend.retrieve({
    text: "*",
    limit: maxDocs,
  });

  if (!result.ok) {
    return {
      documents: [],
      warnings: [`Index source "${config.name ?? "index"}": ${result.error.message}`],
    };
  }

  const documents: ParsedDocument[] = result.value.results.map((r) => ({
    path: r.id,
    title: extractStringField(r.metadata, "title") ?? r.id,
    body: r.content,
    frontmatter: r.metadata,
    tags: extractTagsField(r.metadata),
    lastModified: extractNumberField(r.metadata, "lastModified") ?? Date.now(),
    tokens: Math.ceil(r.content.length / 4),
  }));

  return { documents, warnings: [] };
}

function extractStringField(
  metadata: Readonly<Record<string, unknown>>,
  field: string,
): string | undefined {
  const value = metadata[field];
  return typeof value === "string" ? value : undefined;
}

function extractNumberField(
  metadata: Readonly<Record<string, unknown>>,
  field: string,
): number | undefined {
  const value = metadata[field];
  return typeof value === "number" ? value : undefined;
}

function extractTagsField(metadata: Readonly<Record<string, unknown>>): readonly string[] {
  const raw = metadata.tags;
  if (Array.isArray(raw)) {
    return raw.filter((t): t is string => typeof t === "string");
  }
  return [];
}
