/**
 * Nexus source — queries a remote Nexus endpoint for knowledge documents.
 *
 * Thin HTTP adapter that fetches documents from a Nexus knowledge API
 * and maps them to the internal ParsedDocument format.
 */

import type { NexusSourceConfig, ParsedDocument, ScanResult } from "./types.js";

interface NexusResponse {
  readonly documents?: readonly NexusDocument[];
  readonly error?: string;
}

interface NexusDocument {
  readonly id: string;
  readonly title?: string;
  readonly content: string;
  readonly tags?: readonly string[];
  readonly lastModified?: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Fetch documents from a Nexus knowledge endpoint.
 */
export async function scanNexus(config: NexusSourceConfig, maxDocs: number): Promise<ScanResult> {
  const url = new URL(config.endpoint);
  url.searchParams.set("limit", String(maxDocs));

  const response = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    return {
      documents: [],
      warnings: [
        `Nexus source "${config.name ?? "nexus"}": HTTP ${String(response.status)} ${response.statusText}`,
      ],
    };
  }

  const raw: unknown = await response.json();
  if (!isNexusResponse(raw)) {
    return {
      documents: [],
      warnings: [`Nexus source "${config.name ?? "nexus"}": unexpected response shape`],
    };
  }

  if (raw.error !== undefined) {
    return {
      documents: [],
      warnings: [`Nexus source "${config.name ?? "nexus"}": ${raw.error}`],
    };
  }

  const documents: ParsedDocument[] = (raw.documents ?? []).map((doc) => ({
    path: doc.id,
    title: doc.title ?? doc.id,
    body: doc.content,
    frontmatter: doc.metadata ?? {},
    tags: doc.tags ?? [],
    lastModified: doc.lastModified ?? Date.now(),
    tokens: Math.ceil(doc.content.length / 4),
  }));

  return { documents, warnings: [] };
}

/** Type guard for Nexus API response. Validates shape at system boundary. */
function isNexusResponse(value: unknown): value is NexusResponse {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (obj.error !== undefined && typeof obj.error !== "string") return false;
  if (obj.documents !== undefined && !Array.isArray(obj.documents)) return false;
  return true;
}
