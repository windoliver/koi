/**
 * Runtime view routes — computed state not backed by files.
 *
 * GET /view/agents/tree              — process tree hierarchy
 * GET /view/agents/:id/procfs        — agent runtime state
 * GET /view/middleware/:id           — middleware chain for agent
 * GET /view/gateway/topology         — connected channels/nodes
 * GET /view/forge/bricks             — forge brick metadata
 * GET /view/forge/stats              — forge aggregate stats
 * GET /view/delegations/:agentId     — delegation chain
 * GET /view/handoffs/:agentId        — handoff envelopes
 * GET /view/scratchpad/list          — scratchpad entries
 * GET /view/scratchpad/file          — read scratchpad entry
 * GET /view/governance/queue         — governance pending queue
 */

import { agentId } from "@koi/core";
import type { CommandDispatcher, RuntimeViewDataSource } from "@koi/dashboard-types";
import type { RouteParams } from "../router.js";
import { errorResponse, jsonResponse, validateRequiredParam } from "../router.js";

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

export async function handleForgeBricks(
  _req: Request,
  _params: RouteParams,
  runtimeViews: RuntimeViewDataSource,
): Promise<Response> {
  if (runtimeViews.forge === undefined) {
    return errorResponse("NOT_IMPLEMENTED", "Forge not configured", 501);
  }
  const bricks = await runtimeViews.forge.listBricks();
  return jsonResponse(bricks);
}

export async function handleForgeEvents(
  _req: Request,
  _params: RouteParams,
  runtimeViews: RuntimeViewDataSource,
): Promise<Response> {
  if (runtimeViews.forge === undefined) {
    return errorResponse("NOT_IMPLEMENTED", "Forge not configured", 501);
  }
  const events = await runtimeViews.forge.listRecentEvents();
  return jsonResponse(events);
}

export async function handleForgeStats(
  _req: Request,
  _params: RouteParams,
  runtimeViews: RuntimeViewDataSource,
): Promise<Response> {
  if (runtimeViews.forge === undefined) {
    return errorResponse("NOT_IMPLEMENTED", "Forge not configured", 501);
  }
  const stats = await runtimeViews.forge.getStats();
  return jsonResponse(stats);
}

export async function handleListDelegations(
  _req: Request,
  params: RouteParams,
  commands: CommandDispatcher,
): Promise<Response> {
  const aid = params.agentId;
  if (aid === undefined) {
    return errorResponse("VALIDATION", "Missing agent ID", 400);
  }
  if (commands.listDelegations === undefined) {
    return errorResponse("NOT_IMPLEMENTED", "Delegation listing not supported", 501);
  }
  const result = await commands.listDelegations(agentId(aid));
  if (!result.ok) {
    return errorResponse(result.error.code, result.error.message, 500);
  }
  return jsonResponse(result.value);
}

export async function handleListHandoffs(
  _req: Request,
  params: RouteParams,
  commands: CommandDispatcher,
): Promise<Response> {
  const aid = params.agentId;
  if (aid === undefined) {
    return errorResponse("VALIDATION", "Missing agent ID", 400);
  }
  if (commands.listHandoffs === undefined) {
    return errorResponse("NOT_IMPLEMENTED", "Handoff listing not supported", 501);
  }
  const result = await commands.listHandoffs(agentId(aid));
  if (!result.ok) {
    return errorResponse(result.error.code, result.error.message, 500);
  }
  return jsonResponse(result.value);
}

export async function handleListScratchpad(
  req: Request,
  _params: RouteParams,
  commands: CommandDispatcher,
): Promise<Response> {
  if (commands.listScratchpad === undefined) {
    return errorResponse("NOT_IMPLEMENTED", "Scratchpad listing not supported", 501);
  }
  const groupId = new URL(req.url).searchParams.get("groupId") ?? undefined;
  const result = await commands.listScratchpad(groupId);
  if (!result.ok) {
    return errorResponse(result.error.code, result.error.message, 500);
  }
  return jsonResponse(result.value);
}

export async function handleReadScratchpad(
  req: Request,
  _params: RouteParams,
  commands: CommandDispatcher,
): Promise<Response> {
  if (commands.readScratchpad === undefined) {
    return errorResponse("NOT_IMPLEMENTED", "Scratchpad read not supported", 501);
  }
  const path = new URL(req.url).searchParams.get("path");
  if (path === null) {
    return errorResponse("VALIDATION", "Missing 'path' query parameter", 400);
  }
  const result = await commands.readScratchpad(path);
  if (!result.ok) {
    return errorResponse(result.error.code, result.error.message, 500);
  }
  return jsonResponse(result.value);
}

export async function handleListGovernanceQueue(
  _req: Request,
  _params: RouteParams,
  commands: CommandDispatcher,
): Promise<Response> {
  if (commands.listGovernanceQueue === undefined) {
    return errorResponse("NOT_IMPLEMENTED", "Governance queue not supported", 501);
  }
  const result = await commands.listGovernanceQueue();
  if (!result.ok) {
    return errorResponse(result.error.code, result.error.message, 500);
  }
  return jsonResponse(result.value);
}

export async function handleDebugInventory(
  _req: Request,
  params: RouteParams,
  runtimeViews: RuntimeViewDataSource,
): Promise<Response> {
  if (runtimeViews.debug === undefined) {
    return errorResponse("NOT_IMPLEMENTED", "Debug instrumentation not enabled", 501);
  }
  const id = validateRequiredParam(params, "id", "agent ID");
  if (id instanceof Response) return id;
  const inventory = await runtimeViews.debug.getInventory(agentId(id));
  return jsonResponse(inventory);
}

export async function handleDebugTrace(
  _req: Request,
  params: RouteParams,
  runtimeViews: RuntimeViewDataSource,
): Promise<Response> {
  if (runtimeViews.debug === undefined) {
    return errorResponse("NOT_IMPLEMENTED", "Debug instrumentation not enabled", 501);
  }
  const id = validateRequiredParam(params, "id", "agent ID");
  if (id instanceof Response) return id;
  const turn = validateRequiredParam(params, "turn", "turn index");
  if (turn instanceof Response) return turn;
  const turnIndex = parseInt(turn, 10);
  if (Number.isNaN(turnIndex) || turnIndex < 0) {
    return errorResponse("VALIDATION", "Turn index must be a non-negative integer", 400);
  }
  const trace = await runtimeViews.debug.getTrace(agentId(id), turnIndex);
  if (trace === undefined) {
    return errorResponse("NOT_FOUND", `No trace for turn ${turn} (may have been evicted)`, 404);
  }
  return jsonResponse(trace);
}

export async function handleDebugContributions(
  _req: Request,
  _params: RouteParams,
  runtimeViews: RuntimeViewDataSource,
): Promise<Response> {
  if (runtimeViews.debug === undefined) {
    return errorResponse("NOT_IMPLEMENTED", "Debug instrumentation not enabled", 501);
  }
  if (runtimeViews.debug.getContributions === undefined) {
    return errorResponse("NOT_IMPLEMENTED", "Contribution graph not available", 501);
  }
  const contributions = await runtimeViews.debug.getContributions();
  return jsonResponse(contributions);
}
