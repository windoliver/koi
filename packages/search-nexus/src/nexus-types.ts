/**
 * Internal Nexus REST API v2 response shapes.
 *
 * These types model the wire format from Nexus — not exposed publicly.
 */

export interface NexusSearchHit {
  readonly path: string;
  readonly chunk_text: string;
  readonly chunk_index: number;
  readonly score: number;
  readonly line_start?: number;
  readonly line_end?: number;
  readonly keyword_score?: number;
  readonly vector_score?: number;
}

export interface NexusQueryResponse {
  readonly hits: readonly NexusSearchHit[];
  readonly total: number;
  readonly has_more: boolean;
  readonly cursor?: string;
}

export interface NexusIndexResponse {
  readonly indexed: number;
}

export interface NexusRefreshResponse {
  readonly removed: number;
}

export interface NexusHealthResponse {
  readonly healthy: boolean;
  readonly index_name?: string;
  readonly message?: string;
}

export interface NexusStatsResponse {
  readonly document_count: number;
  readonly index_size_bytes?: number;
  readonly last_refreshed?: string;
}

export interface NexusReindexResponse {
  readonly status: string;
}
