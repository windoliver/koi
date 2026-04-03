/**
 * Skills endpoint — GET /admin/api/skills
 */

import type { DashboardDataSource } from "@koi/dashboard-types";
import type { RouteParams } from "../router.js";
import { jsonResponse } from "../router.js";

export async function handleSkills(
  _req: Request,
  _params: RouteParams,
  dataSource: DashboardDataSource,
): Promise<Response> {
  const skills = await dataSource.listSkills();
  return jsonResponse(skills);
}
