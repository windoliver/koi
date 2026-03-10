/**
 * System metrics endpoint — GET /admin/api/metrics
 */

import type { DashboardDataSource } from "@koi/dashboard-types";
import type { RouteParams } from "../router.js";
import { jsonResponse } from "../router.js";

export async function handleMetrics(
  _req: Request,
  _params: RouteParams,
  dataSource: DashboardDataSource,
): Promise<Response> {
  const metrics = await dataSource.getSystemMetrics();
  return jsonResponse(metrics);
}
