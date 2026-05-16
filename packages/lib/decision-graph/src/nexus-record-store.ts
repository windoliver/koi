import { externalError } from "./errors.js";
import type {
  DecisionGraph,
  DecisionGraphEdge,
  DecisionGraphNode,
  DecisionGraphStore,
} from "./types.js";

export interface NexusRecordStoreDecisionGraphConfig {
  readonly url: string;
  readonly apiKey?: string | undefined;
  readonly fetch?: FetchLike | undefined;
}

export type FetchLike = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface NexusEntity {
  readonly id: string;
  readonly labels?: readonly string[] | undefined;
  readonly properties?: Readonly<Record<string, unknown>> | undefined;
}

interface NexusRelationship {
  readonly id?: string | undefined;
  readonly type?: string | undefined;
  readonly source?: string | undefined;
  readonly target?: string | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly properties?: Readonly<Record<string, unknown>> | undefined;
}

interface NexusGraphResponse {
  readonly entities?: readonly NexusEntity[] | undefined;
  readonly relationships?: readonly NexusRelationship[] | undefined;
  readonly nodes?: readonly DecisionGraphNode[] | undefined;
  readonly edges?: readonly DecisionGraphEdge[] | undefined;
}

export function createNexusRecordStoreDecisionGraphStore(
  config: NexusRecordStoreDecisionGraphConfig,
): DecisionGraphStore {
  const fetchImpl: FetchLike = config.fetch ?? fetch;
  const baseUrl = normalizeUrl(config.url);
  const context = { apiKey: config.apiKey, baseUrl, fetchImpl };

  return {
    upsertGraph: (graph) => upsertGraph(context, graph),
    getGraph: (sessionId) => getGraph(context, sessionId),
    getNeighbors: (query) => getNeighbors(context, query),
    getSubgraph: (query) => getSubgraph(context, query),
  };
}

interface NexusRecordStoreContext {
  readonly apiKey?: string | undefined;
  readonly baseUrl: string;
  readonly fetchImpl: FetchLike;
}

async function upsertGraph(
  context: NexusRecordStoreContext,
  graph: DecisionGraph,
): ReturnType<DecisionGraphStore["upsertGraph"]> {
  const response = await context.fetchImpl(`${context.baseUrl}/api/v2/graph/decision-artifacts`, {
    method: "POST",
    headers: headers(context.apiKey, { "content-type": "application/json" }),
    body: JSON.stringify({ sessionId: graph.sessionId, nodes: graph.nodes, edges: graph.edges }),
  });
  if (response.status === 404 || response.status === 405) {
    return {
      ok: false,
      error: externalError("Nexus decision graph write endpoint unavailable"),
    };
  }
  if (!response.ok) return responseError(response, "Nexus decision graph write failed");
  return { ok: true, value: undefined };
}

async function getGraph(
  context: NexusRecordStoreContext,
  sessionId: string,
): ReturnType<DecisionGraphStore["getGraph"]> {
  const url = new URL(`${context.baseUrl}/api/v2/graph/search`);
  url.searchParams.set("q", sessionId);
  const response = await context.fetchImpl(url, { headers: headers(context.apiKey) });
  if (response.status === 404) return { ok: true, value: undefined };
  if (!response.ok) return responseError(response, "Nexus decision graph fetch failed");
  const graph = toDecisionGraph(sessionId, await response.json());
  return { ok: true, value: graph };
}

async function getNeighbors(
  context: NexusRecordStoreContext,
  query: Parameters<DecisionGraphStore["getNeighbors"]>[0],
): ReturnType<DecisionGraphStore["getNeighbors"]> {
  const url = new URL(
    `${context.baseUrl}/api/v2/graph/entity/${encodeURIComponent(query.nodeId)}/neighbors`,
  );
  url.searchParams.set("hops", String(query.hops ?? 1));
  url.searchParams.set("direction", query.direction ?? "both");
  const response = await context.fetchImpl(url, { headers: headers(context.apiKey) });
  if (!response.ok) return responseError(response, "Nexus decision graph neighbors failed");
  return { ok: true, value: toDecisionGraph(query.sessionId, await response.json()) };
}

async function getSubgraph(
  context: NexusRecordStoreContext,
  query: Parameters<DecisionGraphStore["getSubgraph"]>[0],
): ReturnType<DecisionGraphStore["getSubgraph"]> {
  const response = await context.fetchImpl(`${context.baseUrl}/api/v2/graph/subgraph`, {
    method: "POST",
    headers: headers(context.apiKey, { "content-type": "application/json" }),
    body: JSON.stringify({ entity_ids: query.nodeIds, hops: query.hops ?? 0 }),
  });
  if (!response.ok) return responseError(response, "Nexus decision graph subgraph failed");
  return { ok: true, value: toDecisionGraph(query.sessionId, await response.json()) };
}

function toDecisionGraph(sessionId: string, response: unknown): DecisionGraph {
  const graph = response as NexusGraphResponse;
  if (graph.nodes !== undefined || graph.edges !== undefined) {
    return { sessionId, nodes: graph.nodes ?? [], edges: graph.edges ?? [] };
  }
  const nodes = (graph.entities ?? []).map((entity): DecisionGraphNode => {
    const properties = entity.properties ?? {};
    return {
      id: entity.id,
      sessionId: metadataString(properties, "sessionId") ?? sessionId,
      kind: nodeKind(entity.labels),
      label: metadataString(properties, "label") ?? entity.id,
      ...(metadataNumber(properties, "timestamp") !== undefined
        ? { timestamp: metadataNumber(properties, "timestamp") }
        : {}),
      metadata: properties,
    };
  });
  const edges = (graph.relationships ?? []).flatMap(
    (relationship): readonly DecisionGraphEdge[] => {
      const from = relationship.from ?? relationship.source;
      const to = relationship.to ?? relationship.target;
      if (from === undefined || to === undefined) return [];
      return [
        {
          id: relationship.id ?? `${relationship.type ?? "related"}:${from}:${to}`,
          sessionId,
          kind: edgeKind(relationship.type),
          from,
          to,
          ...(relationship.properties !== undefined ? { metadata: relationship.properties } : {}),
        },
      ];
    },
  );
  return { sessionId, nodes, edges };
}

function nodeKind(labels: readonly string[] | undefined): DecisionGraphNode["kind"] {
  if (labels?.includes("trajectory_step")) return "trajectory_step";
  if (labels?.includes("audit_entry")) return "audit_entry";
  if (labels?.includes("run_report")) return "run_report";
  if (labels?.includes("outcome")) return "outcome";
  if (labels?.includes("issue")) return "issue";
  if (labels?.includes("recommendation")) return "recommendation";
  return "session";
}

function edgeKind(type: string | undefined): DecisionGraphEdge["kind"] {
  if (type === "precedes") return "precedes";
  if (type === "corroborates") return "corroborates";
  if (type === "produced") return "produced";
  if (type === "summarizes") return "summarizes";
  if (type === "raises") return "raises";
  if (type === "recommends") return "recommends";
  return "contains";
}

function headers(
  apiKey: string | undefined,
  extra?: Readonly<Record<string, string>>,
): Record<string, string> {
  return {
    ...(apiKey !== undefined ? { authorization: `Bearer ${apiKey}` } : {}),
    ...(extra ?? {}),
  };
}

function responseError(response: Response, message: string) {
  return {
    ok: false as const,
    error: externalError(`${message}: ${response.status} ${response.statusText}`),
  };
}

function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function metadataString(
  metadata: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = metadata[key];
  return typeof value === "string" ? value : undefined;
}

function metadataNumber(
  metadata: Readonly<Record<string, unknown>>,
  key: string,
): number | undefined {
  const value = metadata[key];
  return typeof value === "number" ? value : undefined;
}
