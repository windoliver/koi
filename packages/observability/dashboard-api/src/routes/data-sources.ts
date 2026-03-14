/**
 * Data source REST routes.
 *
 * GET  /data-sources             — list discovered data sources
 * POST /data-sources/:name/approve — approve a pending data source
 * GET  /data-sources/:name/schema  — get inferred schema for a source
 */

import type { DashboardDataSource } from "@koi/dashboard-types";
import type { RouteParams } from "../router.js";
import { errorResponse, jsonResponse } from "../router.js";

export async function handleListDataSources(
  _req: Request,
  _params: RouteParams,
  dataSource: DashboardDataSource,
): Promise<Response> {
  if (dataSource.listDataSources === undefined) {
    return jsonResponse([]);
  }
  const sources = await dataSource.listDataSources();
  return jsonResponse(sources);
}

export async function handleApproveDataSource(
  _req: Request,
  params: RouteParams,
  dataSource: DashboardDataSource,
): Promise<Response> {
  const name = params.name;
  if (name === undefined) {
    return errorResponse("VALIDATION", "Missing data source name", 400);
  }
  if (dataSource.approveDataSource === undefined) {
    return errorResponse("NOT_IMPLEMENTED", "Data source approval not supported", 501);
  }
  const result = await dataSource.approveDataSource(name);
  if (!result.ok) {
    const status = result.error.code === "NOT_FOUND" ? 404 : 500;
    return errorResponse(result.error.code, result.error.message, status);
  }
  return jsonResponse(null);
}

export async function handleRescanDataSources(
  _req: Request,
  _params: RouteParams,
  dataSource: DashboardDataSource,
): Promise<Response> {
  if (dataSource.rescanDataSources === undefined) {
    return errorResponse("NOT_IMPLEMENTED", "Data source re-scan not supported", 501);
  }
  const sources = await dataSource.rescanDataSources();
  return jsonResponse(sources);
}

export async function handleGetDataSourceSchema(
  _req: Request,
  params: RouteParams,
  dataSource: DashboardDataSource,
): Promise<Response> {
  const name = params.name;
  if (name === undefined) {
    return errorResponse("VALIDATION", "Missing data source name", 400);
  }
  if (dataSource.getDataSourceSchema === undefined) {
    return errorResponse("NOT_IMPLEMENTED", "Data source schema not supported", 501);
  }
  const schema = await dataSource.getDataSourceSchema(name);
  if (schema === undefined) {
    return errorResponse("NOT_FOUND", `Data source "${name}" not found`, 404);
  }
  return jsonResponse(schema);
}
