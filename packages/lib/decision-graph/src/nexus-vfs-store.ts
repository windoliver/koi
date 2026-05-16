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
  const context = { basePath, transport };

  return {
    upsertGraph: (graph) => upsertGraph(context, graph),
    getGraph: (sessionId) => getGraph(context, sessionId),
    getNeighbors: (query) => getNeighbors(context, query),
    getSubgraph: (query) => getSubgraph(context, query),
  };
}

interface NexusVfsStoreContext {
  readonly basePath: string;
  readonly transport: NexusVfsTransport;
}

async function upsertGraph(
  context: NexusVfsStoreContext,
  graph: DecisionGraph,
): ReturnType<DecisionGraphStore["upsertGraph"]> {
  const graphResult = await writeJson(
    context.transport,
    sessionPath(context.basePath, graph.sessionId),
    graph,
  );
  if (!graphResult.ok) return graphResult;
  const members = await writeGraphMembers(context, graph);
  if (!members.ok) return members;
  return writeNodeEdgeIndexes(context, graph);
}

async function writeGraphMembers(
  context: NexusVfsStoreContext,
  graph: DecisionGraph,
): Promise<Result<void, KoiError>> {
  for (const node of graph.nodes) {
    const result = await writeJson(context.transport, nodePath(context.basePath, node.id), node);
    if (!result.ok) return result;
  }
  for (const edge of graph.edges) {
    const result = await writeJson(context.transport, edgePath(context.basePath, edge.id), edge);
    if (!result.ok) return result;
  }
  return { ok: true, value: undefined };
}

async function writeNodeEdgeIndexes(
  context: NexusVfsStoreContext,
  graph: DecisionGraph,
): Promise<Result<void, KoiError>> {
  for (const node of graph.nodes) {
    const edgeIds = graph.edges
      .filter((edge) => edge.from === node.id || edge.to === node.id)
      .map((edge) => edge.id);
    const result = await writeJson(
      context.transport,
      byNodePath(context.basePath, node.id),
      edgeIds,
    );
    if (!result.ok) return result;
  }
  return { ok: true, value: undefined };
}

async function getGraph(
  context: NexusVfsStoreContext,
  sessionId: string,
): ReturnType<DecisionGraphStore["getGraph"]> {
  const result = await readJson<DecisionGraph>(
    context.transport,
    sessionPath(context.basePath, sessionId),
  );
  if (!result.ok) {
    if (result.error.code === "NOT_FOUND") return { ok: true, value: undefined };
    return result;
  }
  return result;
}

async function getNeighbors(
  context: NexusVfsStoreContext,
  query: Parameters<DecisionGraphStore["getNeighbors"]>[0],
): ReturnType<DecisionGraphStore["getNeighbors"]> {
  return queryLoadedGraph(context, query, (memory) => memory.getNeighbors(query));
}

async function getSubgraph(
  context: NexusVfsStoreContext,
  query: Parameters<DecisionGraphStore["getSubgraph"]>[0],
): ReturnType<DecisionGraphStore["getSubgraph"]> {
  return queryLoadedGraph(context, query, (memory) => memory.getSubgraph(query));
}

async function queryLoadedGraph<T>(
  context: NexusVfsStoreContext,
  query: { readonly sessionId: string },
  run: (memory: DecisionGraphStore) => Promise<Result<T, KoiError>>,
): Promise<Result<T, KoiError>> {
  const graph = await loadGraph(context.transport, context.basePath, query.sessionId);
  if (!graph.ok) return graph;
  if (graph.value === undefined) {
    return { ok: true, value: { sessionId: query.sessionId, nodes: [], edges: [] } as T };
  }
  const memory = createInMemoryDecisionGraphStore();
  const upserted = await memory.upsertGraph(graph.value);
  if (!upserted.ok) return upserted;
  return run(memory);
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
