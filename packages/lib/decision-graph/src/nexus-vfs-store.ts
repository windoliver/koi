import type { KoiError, Result } from "@koi/core";
import { externalError, validationError } from "./errors.js";
import { createInMemoryDecisionGraphStore } from "./in-memory-store.js";
import type {
  DecisionGraph,
  DecisionGraphEdge,
  DecisionGraphNode,
  DecisionGraphStore,
} from "./types.js";

export interface NexusVfsTransport {
  readonly call: <T>(
    method: string,
    params: Record<string, unknown>,
  ) => Promise<Result<T, KoiError>>;
}

export interface NexusVfsDecisionGraphStoreConfig {
  readonly transport: NexusVfsTransport;
  readonly basePath?: string | undefined;
}

const DEFAULT_BASE_PATH = "decision-graph";

export function createNexusVfsDecisionGraphStore(
  config: NexusVfsDecisionGraphStoreConfig,
): DecisionGraphStore {
  const basePath = normalizeBasePath(config.basePath ?? DEFAULT_BASE_PATH);
  const transport = config.transport;

  return {
    async upsertGraph(graph) {
      const graphResult = await writeJson(transport, sessionPath(basePath, graph.sessionId), graph);
      if (!graphResult.ok) return graphResult;
      for (const node of graph.nodes) {
        const result = await writeJson(transport, nodePath(basePath, node.id), node);
        if (!result.ok) return result;
      }
      for (const edge of graph.edges) {
        const result = await writeJson(transport, edgePath(basePath, edge.id), edge);
        if (!result.ok) return result;
      }
      for (const node of graph.nodes) {
        const edgeIds = graph.edges
          .filter((edge) => edge.from === node.id || edge.to === node.id)
          .map((edge) => edge.id);
        const result = await writeJson(transport, byNodePath(basePath, node.id), edgeIds);
        if (!result.ok) return result;
      }
      return { ok: true, value: undefined };
    },
    async getGraph(sessionId) {
      const result = await readJson<DecisionGraph>(transport, sessionPath(basePath, sessionId));
      if (!result.ok) {
        if (result.error.code === "NOT_FOUND") return { ok: true, value: undefined };
        return result;
      }
      return result;
    },
    async getNeighbors(query) {
      const graph = await loadGraph(transport, basePath, query.sessionId);
      if (!graph.ok) return graph;
      if (graph.value === undefined) {
        return { ok: true, value: { sessionId: query.sessionId, nodes: [], edges: [] } };
      }
      const memory = createInMemoryDecisionGraphStore();
      const upserted = await memory.upsertGraph(graph.value);
      if (!upserted.ok) return upserted;
      return memory.getNeighbors(query);
    },
    async getSubgraph(query) {
      const graph = await loadGraph(transport, basePath, query.sessionId);
      if (!graph.ok) return graph;
      if (graph.value === undefined) {
        return { ok: true, value: { sessionId: query.sessionId, nodes: [], edges: [] } };
      }
      const memory = createInMemoryDecisionGraphStore();
      const upserted = await memory.upsertGraph(graph.value);
      if (!upserted.ok) return upserted;
      return memory.getSubgraph(query);
    },
  };
}

async function loadGraph(
  transport: NexusVfsTransport,
  basePath: string,
  sessionId: string,
): Promise<Result<DecisionGraph | undefined, KoiError>> {
  const result = await readJson<DecisionGraph>(transport, sessionPath(basePath, sessionId));
  if (!result.ok) {
    if (result.error.code === "NOT_FOUND") return { ok: true, value: undefined };
    return result;
  }
  return result;
}

async function writeJson(
  transport: NexusVfsTransport,
  path: string,
  value: DecisionGraph | DecisionGraphNode | DecisionGraphEdge | readonly string[],
): Promise<Result<void, KoiError>> {
  const result = await transport.call<unknown>("write", { path, content: JSON.stringify(value) });
  if (!result.ok) return result;
  return { ok: true, value: undefined };
}

async function readJson<T>(
  transport: NexusVfsTransport,
  path: string,
): Promise<Result<T, KoiError>> {
  const result = await transport.call<unknown>("read", { path });
  if (!result.ok) return result;
  try {
    return { ok: true, value: decodeJson<T>(result.value) };
  } catch (cause) {
    return { ok: false, error: externalError(`Invalid graph JSON at ${path}`, cause) };
  }
}

function decodeJson<T>(value: unknown): T {
  if (typeof value === "string") return JSON.parse(value) as T;
  if (typeof value === "object" && value !== null && "content" in value) {
    const content = (value as { readonly content?: unknown }).content;
    if (typeof content === "string") return JSON.parse(content) as T;
  }
  return value as T;
}

function normalizeBasePath(basePath: string): string {
  if (basePath.trim().length === 0) {
    throw new Error(validationError("decision graph basePath must not be empty").message);
  }
  const trimmed = basePath.replace(/^\/+/, "").replace(/\/+$/, "");
  return `/${trimmed}`;
}

function sessionPath(basePath: string, sessionId: string): string {
  return `${basePath}/sessions/${encodeURIComponent(sessionId)}.json`;
}

function nodePath(basePath: string, nodeId: string): string {
  return `${basePath}/nodes/${encodeURIComponent(nodeId)}.json`;
}

function edgePath(basePath: string, edgeId: string): string {
  return `${basePath}/edges/${encodeURIComponent(edgeId)}.json`;
}

function byNodePath(basePath: string, nodeId: string): string {
  return `${basePath}/index/by-node/${encodeURIComponent(nodeId)}.json`;
}
