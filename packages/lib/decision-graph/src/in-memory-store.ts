import type { KoiError, Result } from "@koi/core";
import { validationError } from "./errors.js";
import type {
  DecisionGraph,
  DecisionGraphEdge,
  DecisionGraphNeighborsQuery,
  DecisionGraphNode,
  DecisionGraphStore,
} from "./types.js";

export function createInMemoryDecisionGraphStore(): DecisionGraphStore {
  const graphs = new Map<string, DecisionGraph>();

  return {
    async upsertGraph(graph) {
      graphs.set(graph.sessionId, graph);
      return { ok: true, value: undefined };
    },
    async getGraph(sessionId) {
      return { ok: true, value: graphs.get(sessionId) };
    },
    async getNeighbors(query) {
      const graph = graphs.get(query.sessionId);
      if (graph === undefined) return { ok: true, value: emptyGraph(query.sessionId) };
      const validation = validateKnownNode(graph, query.nodeId);
      if (!validation.ok) return validation;
      return { ok: true, value: selectNeighborhood(graph, query) };
    },
    async getSubgraph(query) {
      const graph = graphs.get(query.sessionId);
      if (graph === undefined) return { ok: true, value: emptyGraph(query.sessionId) };
      const selected = new Set(query.nodeIds);
      const hops = query.hops ?? 0;
      for (let i = 0; i < hops; i += 1) {
        for (const edge of graph.edges) {
          if (selected.has(edge.from) || selected.has(edge.to)) {
            selected.add(edge.from);
            selected.add(edge.to);
          }
        }
      }
      return { ok: true, value: selectGraph(graph, selected) };
    },
  };
}

function validateKnownNode(graph: DecisionGraph, nodeId: string): Result<void, KoiError> {
  if (graph.nodes.some((node) => node.id === nodeId)) return { ok: true, value: undefined };
  return { ok: false, error: validationError(`Unknown graph node: ${nodeId}`) };
}

function selectNeighborhood(
  graph: DecisionGraph,
  query: DecisionGraphNeighborsQuery,
): DecisionGraph {
  const selected = new Set([query.nodeId]);
  const direction = query.direction ?? "both";
  const hops = query.hops ?? 1;
  for (let i = 0; i < hops; i += 1) {
    for (const edge of graph.edges) {
      const outgoing = direction === "outgoing" || direction === "both";
      const incoming = direction === "incoming" || direction === "both";
      if (outgoing && selected.has(edge.from)) selected.add(edge.to);
      if (incoming && selected.has(edge.to)) selected.add(edge.from);
    }
  }
  return selectGraph(graph, selected);
}

function selectGraph(graph: DecisionGraph, selected: ReadonlySet<string>): DecisionGraph {
  const nodes = graph.nodes.filter((node) => selected.has(node.id));
  const edges = graph.edges.filter((edge) => selected.has(edge.from) && selected.has(edge.to));
  return { sessionId: graph.sessionId, nodes, edges };
}

function emptyGraph(sessionId: string): DecisionGraph {
  return { sessionId, nodes: [], edges: [] };
}

export type { DecisionGraphEdge, DecisionGraphNode };
