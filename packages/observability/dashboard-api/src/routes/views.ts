/**
 * Runtime view routes — computed state not backed by files.
 *
 * GET /view/agents/tree       — process tree hierarchy
 * GET /view/agents/:id/procfs — agent runtime state
 * GET /view/middleware/:id    — middleware chain for agent
 * GET /view/gateway/topology  — connected channels/nodes
 */

import { agentId } from "@koi/core";
import type { RuntimeViewDataSource } from "@koi/dashboard-types";
import type { RouteParams } from "../router.js";
import { errorResponse, jsonResponse } from "../router.js";

export async function handleProcessTree(
  _req: Request,
  _params: RouteParams,
  runtimeViews: RuntimeViewDataSource,
): Promise<Response> {
  const tree = await runtimeViews.getProcessTree();
  return jsonResponse(tree);
}

export async function handleAgentProcfs(
  _req: Request,
  params: RouteParams,
  runtimeViews: RuntimeViewDataSource,
): Promise<Response> {
  const id = params.id;
  if (id === undefined) {
    return errorResponse("VALIDATION", "Missing agent ID", 400);
  }

  const procfs = await runtimeViews.getAgentProcfs(agentId(id));
  if (procfs === undefined) {
    return errorResponse("NOT_FOUND", `Agent "${id}" not found`, 404);
  }
  return jsonResponse(procfs);
}

export async function handleMiddlewareChain(
  _req: Request,
  params: RouteParams,
  runtimeViews: RuntimeViewDataSource,
): Promise<Response> {
  const id = params.id;
  if (id === undefined) {
    return errorResponse("VALIDATION", "Missing agent ID", 400);
  }

  const chain = await runtimeViews.getMiddlewareChain(agentId(id));
  return jsonResponse(chain);
}

export async function handleGatewayTopology(
  _req: Request,
  _params: RouteParams,
  runtimeViews: RuntimeViewDataSource,
): Promise<Response> {
  const topology = await runtimeViews.getGatewayTopology();
  return jsonResponse(topology);
}
