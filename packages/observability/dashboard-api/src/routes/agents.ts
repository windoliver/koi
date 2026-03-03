/**
 * Agent REST routes.
 *
 * GET  /agents      — list all agents
 * GET  /agents/:id  — get agent detail
 * POST /agents/:id/terminate — terminate an agent
 */

import { agentId } from "@koi/core";
import type { DashboardDataSource } from "@koi/dashboard-types";
import type { RouteParams } from "../router.js";
import { errorResponse, jsonResponse } from "../router.js";

export async function handleListAgents(
  _req: Request,
  _params: RouteParams,
  dataSource: DashboardDataSource,
): Promise<Response> {
  const agents = await dataSource.listAgents();
  return jsonResponse(agents);
}

export async function handleGetAgent(
  _req: Request,
  params: RouteParams,
  dataSource: DashboardDataSource,
): Promise<Response> {
  const id = params.id;
  if (id === undefined) {
    return errorResponse("VALIDATION", "Missing agent ID", 400);
  }
  const agent = await dataSource.getAgent(agentId(id));
  if (agent === undefined) {
    return errorResponse("NOT_FOUND", `Agent "${id}" not found`, 404);
  }
  return jsonResponse(agent);
}

export async function handleTerminateAgent(
  _req: Request,
  params: RouteParams,
  dataSource: DashboardDataSource,
): Promise<Response> {
  const id = params.id;
  if (id === undefined) {
    return errorResponse("VALIDATION", "Missing agent ID", 400);
  }
  const result = await dataSource.terminateAgent(agentId(id));
  if (!result.ok) {
    const status = result.error.code === "NOT_FOUND" ? 404 : 500;
    return errorResponse(result.error.code, result.error.message, status);
  }
  return jsonResponse(null);
}
