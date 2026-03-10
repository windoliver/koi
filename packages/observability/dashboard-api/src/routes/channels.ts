/**
 * Channels endpoint — GET /admin/api/channels
 */

import type { DashboardDataSource } from "@koi/dashboard-types";
import type { RouteParams } from "../router.js";
import { jsonResponse } from "../router.js";

export async function handleChannels(
  _req: Request,
  _params: RouteParams,
  dataSource: DashboardDataSource,
): Promise<Response> {
  const channels = await dataSource.listChannels();
  return jsonResponse(channels);
}
