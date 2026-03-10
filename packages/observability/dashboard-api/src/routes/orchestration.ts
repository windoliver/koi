/**
 * Orchestration view + command routes — Phase 2.
 *
 * Temporal, Scheduler, Task Board, and Harness runtime data.
 * All views are optional — routes only registered when data source is provided.
 */

import type { CommandDispatcher, RuntimeViewDataSource } from "@koi/dashboard-types";
import type { RouteParams } from "../router.js";
import {
  errorResponse,
  jsonResponse,
  mapResultToResponse,
  validateRequiredParam,
} from "../router.js";

// ---------------------------------------------------------------------------
// Temporal views
// ---------------------------------------------------------------------------

export async function handleTemporalHealth(
  _req: Request,
  _params: RouteParams,
  runtimeViews: RuntimeViewDataSource,
): Promise<Response> {
  if (runtimeViews.temporal === undefined) {
    return errorResponse("NOT_IMPLEMENTED", "Temporal not configured", 501);
  }
  const health = await runtimeViews.temporal.getHealth();
  return jsonResponse(health);
}

export async function handleTemporalWorkflows(
  _req: Request,
  _params: RouteParams,
  runtimeViews: RuntimeViewDataSource,
): Promise<Response> {
  if (runtimeViews.temporal === undefined) {
    return errorResponse("NOT_IMPLEMENTED", "Temporal not configured", 501);
  }
  const workflows = await runtimeViews.temporal.listWorkflows();
  return jsonResponse(workflows);
}

export async function handleTemporalWorkflow(
  _req: Request,
  params: RouteParams,
  runtimeViews: RuntimeViewDataSource,
): Promise<Response> {
  if (runtimeViews.temporal === undefined) {
    return errorResponse("NOT_IMPLEMENTED", "Temporal not configured", 501);
  }
  const id = validateRequiredParam(params, "id", "workflow ID");
  if (id instanceof Response) return id;

  const workflow = await runtimeViews.temporal.getWorkflow(id);
  if (workflow === undefined) {
    return errorResponse("NOT_FOUND", `Workflow "${id}" not found`, 404);
  }
  return jsonResponse(workflow);
}

// ---------------------------------------------------------------------------
// Scheduler views
// ---------------------------------------------------------------------------

export async function handleSchedulerTasks(
  _req: Request,
  _params: RouteParams,
  runtimeViews: RuntimeViewDataSource,
): Promise<Response> {
  if (runtimeViews.scheduler === undefined) {
    return errorResponse("NOT_IMPLEMENTED", "Scheduler not configured", 501);
  }
  const tasks = await runtimeViews.scheduler.listTasks();
  return jsonResponse(tasks);
}

export async function handleSchedulerStats(
  _req: Request,
  _params: RouteParams,
  runtimeViews: RuntimeViewDataSource,
): Promise<Response> {
  if (runtimeViews.scheduler === undefined) {
    return errorResponse("NOT_IMPLEMENTED", "Scheduler not configured", 501);
  }
  const stats = await runtimeViews.scheduler.getStats();
  return jsonResponse(stats);
}

export async function handleSchedulerSchedules(
  _req: Request,
  _params: RouteParams,
  runtimeViews: RuntimeViewDataSource,
): Promise<Response> {
  if (runtimeViews.scheduler === undefined) {
    return errorResponse("NOT_IMPLEMENTED", "Scheduler not configured", 501);
  }
  const schedules = await runtimeViews.scheduler.listSchedules();
  return jsonResponse(schedules);
}

export async function handleSchedulerDlq(
  _req: Request,
  _params: RouteParams,
  runtimeViews: RuntimeViewDataSource,
): Promise<Response> {
  if (runtimeViews.scheduler === undefined) {
    return errorResponse("NOT_IMPLEMENTED", "Scheduler not configured", 501);
  }
  const entries = await runtimeViews.scheduler.listDeadLetters();
  return jsonResponse(entries);
}

// ---------------------------------------------------------------------------
// Task board views
// ---------------------------------------------------------------------------

export async function handleTaskBoard(
  _req: Request,
  _params: RouteParams,
  runtimeViews: RuntimeViewDataSource,
): Promise<Response> {
  if (runtimeViews.taskBoard === undefined) {
    return errorResponse("NOT_IMPLEMENTED", "Task board not configured", 501);
  }
  const snapshot = await runtimeViews.taskBoard.getSnapshot();
  return jsonResponse(snapshot);
}

// ---------------------------------------------------------------------------
// Harness views
// ---------------------------------------------------------------------------

export async function handleHarnessStatus(
  _req: Request,
  _params: RouteParams,
  runtimeViews: RuntimeViewDataSource,
): Promise<Response> {
  if (runtimeViews.harness === undefined) {
    return errorResponse("NOT_IMPLEMENTED", "Harness not configured", 501);
  }
  const status = await runtimeViews.harness.getStatus();
  return jsonResponse(status);
}

export async function handleHarnessCheckpoints(
  _req: Request,
  _params: RouteParams,
  runtimeViews: RuntimeViewDataSource,
): Promise<Response> {
  if (runtimeViews.harness === undefined) {
    return errorResponse("NOT_IMPLEMENTED", "Harness not configured", 501);
  }
  const checkpoints = await runtimeViews.harness.getCheckpoints();
  return jsonResponse(checkpoints);
}

// ---------------------------------------------------------------------------
// Orchestration commands
// ---------------------------------------------------------------------------

export async function handleSignalWorkflow(
  req: Request,
  params: RouteParams,
  commands: CommandDispatcher,
): Promise<Response> {
  if (commands.signalWorkflow === undefined) {
    return errorResponse("NOT_IMPLEMENTED", "Workflow signal not supported", 501);
  }
  const id = validateRequiredParam(params, "id", "workflow ID");
  if (id instanceof Response) return id;

  let body: { readonly signal: string; readonly payload?: unknown };
  try {
    body = (await req.json()) as { readonly signal: string; readonly payload?: unknown };
  } catch {
    return errorResponse("VALIDATION", "Invalid JSON body", 400);
  }
  if (typeof body.signal !== "string") {
    return errorResponse("VALIDATION", "Missing 'signal' field in body", 400);
  }

  const result = await commands.signalWorkflow(id, body.signal, body.payload);
  const errResponse = mapResultToResponse(result);
  if (errResponse !== undefined) return errResponse;
  return jsonResponse(null);
}

export async function handleTerminateWorkflow(
  _req: Request,
  params: RouteParams,
  commands: CommandDispatcher,
): Promise<Response> {
  if (commands.terminateWorkflow === undefined) {
    return errorResponse("NOT_IMPLEMENTED", "Workflow terminate not supported", 501);
  }
  const id = validateRequiredParam(params, "id", "workflow ID");
  if (id instanceof Response) return id;

  const result = await commands.terminateWorkflow(id);
  const errResponse = mapResultToResponse(result);
  if (errResponse !== undefined) return errResponse;
  return jsonResponse(null);
}

export async function handlePauseSchedule(
  _req: Request,
  params: RouteParams,
  commands: CommandDispatcher,
): Promise<Response> {
  if (commands.pauseSchedule === undefined) {
    return errorResponse("NOT_IMPLEMENTED", "Schedule pause not supported", 501);
  }
  const id = validateRequiredParam(params, "id", "schedule ID");
  if (id instanceof Response) return id;

  const result = await commands.pauseSchedule(id);
  const errResponse = mapResultToResponse(result);
  if (errResponse !== undefined) return errResponse;
  return jsonResponse(null);
}

export async function handleResumeSchedule(
  _req: Request,
  params: RouteParams,
  commands: CommandDispatcher,
): Promise<Response> {
  if (commands.resumeSchedule === undefined) {
    return errorResponse("NOT_IMPLEMENTED", "Schedule resume not supported", 501);
  }
  const id = validateRequiredParam(params, "id", "schedule ID");
  if (id instanceof Response) return id;

  const result = await commands.resumeSchedule(id);
  const errResponse = mapResultToResponse(result);
  if (errResponse !== undefined) return errResponse;
  return jsonResponse(null);
}

export async function handleDeleteSchedule(
  _req: Request,
  params: RouteParams,
  commands: CommandDispatcher,
): Promise<Response> {
  if (commands.deleteSchedule === undefined) {
    return errorResponse("NOT_IMPLEMENTED", "Schedule delete not supported", 501);
  }
  const id = validateRequiredParam(params, "id", "schedule ID");
  if (id instanceof Response) return id;

  const result = await commands.deleteSchedule(id);
  const errResponse = mapResultToResponse(result);
  if (errResponse !== undefined) return errResponse;
  return jsonResponse(null);
}

export async function handleRetrySchedulerDlq(
  _req: Request,
  params: RouteParams,
  commands: CommandDispatcher,
): Promise<Response> {
  if (commands.retrySchedulerDeadLetter === undefined) {
    return errorResponse("NOT_IMPLEMENTED", "Scheduler DLQ retry not supported", 501);
  }
  const id = validateRequiredParam(params, "id", "dead letter ID");
  if (id instanceof Response) return id;

  const result = await commands.retrySchedulerDeadLetter(id);
  const errResponse = mapResultToResponse(result);
  if (errResponse !== undefined) return errResponse;
  return jsonResponse(null);
}

export async function handlePauseHarness(
  _req: Request,
  _params: RouteParams,
  commands: CommandDispatcher,
): Promise<Response> {
  if (commands.pauseHarness === undefined) {
    return errorResponse("NOT_IMPLEMENTED", "Harness pause not supported", 501);
  }
  const result = await commands.pauseHarness();
  const errResponse = mapResultToResponse(result);
  if (errResponse !== undefined) return errResponse;
  return jsonResponse(null);
}

export async function handleResumeHarness(
  _req: Request,
  _params: RouteParams,
  commands: CommandDispatcher,
): Promise<Response> {
  if (commands.resumeHarness === undefined) {
    return errorResponse("NOT_IMPLEMENTED", "Harness resume not supported", 501);
  }
  const result = await commands.resumeHarness();
  const errResponse = mapResultToResponse(result);
  if (errResponse !== undefined) return errResponse;
  return jsonResponse(null);
}
