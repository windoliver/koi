/**
 * Command routes — imperative operations (not file-backed).
 *
 * POST /cmd/agents/dispatch              — dispatch new agent
 * POST /cmd/agents/:id/suspend           — suspend agent
 * POST /cmd/agents/:id/resume            — resume agent
 * POST /cmd/agents/:id/terminate         — terminate agent
 * POST /cmd/events/dlq/:id/retry         — retry dead letter
 * POST /cmd/mailbox/:agentId/list        — list agent mailbox
 * POST /cmd/governance/:id/review        — approve/reject governance item
 * POST /cmd/forge/bricks/:id/promote     — promote brick
 * POST /cmd/forge/bricks/:id/demote      — demote brick
 * POST /cmd/forge/bricks/:id/quarantine  — quarantine brick
 * POST /cmd/tasks/add                    — add task to board
 * POST /cmd/tasks/:id/update             — update task description/priority
 * POST /cmd/tasks/:id/cancel             — cancel task
 */

import type { TaskItemInput } from "@koi/core";
import { agentId, taskItemId } from "@koi/core";
import type { CommandDispatcher, DispatchAgentRequest } from "@koi/dashboard-types";
import type { RouteParams } from "../router.js";
import { errorResponse, jsonResponse } from "../router.js";

/** Map a KoiError code to an HTTP status. */
function errorCodeToStatus(code: string): number {
  switch (code) {
    case "NOT_FOUND":
      return 404;
    case "CONFLICT":
      return 409;
    default:
      return 500;
  }
}

function handleCommandResult(result: {
  readonly ok: boolean;
  readonly error?: { readonly code: string; readonly message: string };
}): Response {
  if (!result.ok && result.error !== undefined) {
    return errorResponse(
      result.error.code,
      result.error.message,
      errorCodeToStatus(result.error.code),
    );
  }
  return jsonResponse(null);
}

export async function handleDispatchAgent(
  req: Request,
  _params: RouteParams,
  commands: CommandDispatcher,
): Promise<Response> {
  if (commands.dispatchAgent === undefined) {
    return errorResponse("NOT_IMPLEMENTED", "Agent dispatch not supported", 501);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse("VALIDATION", "Invalid JSON body", 400);
  }

  if (typeof body !== "object" || body === null) {
    return errorResponse("VALIDATION", "Request body must be an object", 400);
  }

  const { name, manifest, message } = body as Record<string, unknown>;
  if (typeof name !== "string" || name.trim() === "") {
    return errorResponse("VALIDATION", "Missing or empty 'name' field", 400);
  }

  const request: DispatchAgentRequest = {
    name: name.trim(),
    ...(typeof manifest === "string" ? { manifest } : {}),
    ...(typeof message === "string" ? { message } : {}),
  };

  const result = await commands.dispatchAgent(request);
  if (!result.ok) {
    const status =
      result.error.code === "NOT_FOUND" ? 404 : result.error.code === "CONFLICT" ? 409 : 500;
    return errorResponse(result.error.code, result.error.message, status);
  }

  return jsonResponse(result.value);
}

export async function handleSuspendAgent(
  _req: Request,
  params: RouteParams,
  commands: CommandDispatcher,
): Promise<Response> {
  const id = params.id;
  if (id === undefined) {
    return errorResponse("VALIDATION", "Missing agent ID", 400);
  }
  const result = await commands.suspendAgent(agentId(id));
  return handleCommandResult(result);
}

export async function handleResumeAgent(
  _req: Request,
  params: RouteParams,
  commands: CommandDispatcher,
): Promise<Response> {
  const id = params.id;
  if (id === undefined) {
    return errorResponse("VALIDATION", "Missing agent ID", 400);
  }
  const result = await commands.resumeAgent(agentId(id));
  return handleCommandResult(result);
}

export async function handleTerminateAgentCmd(
  _req: Request,
  params: RouteParams,
  commands: CommandDispatcher,
): Promise<Response> {
  const id = params.id;
  if (id === undefined) {
    return errorResponse("VALIDATION", "Missing agent ID", 400);
  }
  const result = await commands.terminateAgent(agentId(id));
  return handleCommandResult(result);
}

export async function handleRetryDeadLetter(
  _req: Request,
  params: RouteParams,
  commands: CommandDispatcher,
): Promise<Response> {
  const id = params.id;
  if (id === undefined) {
    return errorResponse("VALIDATION", "Missing dead letter ID", 400);
  }
  if (commands.retryDeadLetter === undefined) {
    return errorResponse("NOT_IMPLEMENTED", "Dead letter retry not supported", 501);
  }
  const result = await commands.retryDeadLetter(id);
  if (!result.ok) {
    return errorResponse(
      result.error.code,
      result.error.message,
      errorCodeToStatus(result.error.code),
    );
  }
  return jsonResponse({ retried: result.value });
}

export async function handleListMailbox(
  _req: Request,
  params: RouteParams,
  commands: CommandDispatcher,
): Promise<Response> {
  const aid = params.agentId;
  if (aid === undefined) {
    return errorResponse("VALIDATION", "Missing agent ID", 400);
  }
  if (commands.listMailbox === undefined) {
    return errorResponse("NOT_IMPLEMENTED", "Mailbox not supported", 501);
  }
  const result = await commands.listMailbox(agentId(aid));
  if (!result.ok) {
    return errorResponse(
      result.error.code,
      result.error.message,
      errorCodeToStatus(result.error.code),
    );
  }
  return jsonResponse(result.value);
}

export async function handleReviewGovernance(
  req: Request,
  params: RouteParams,
  commands: CommandDispatcher,
): Promise<Response> {
  const id = params.id;
  if (id === undefined) {
    return errorResponse("VALIDATION", "Missing governance item ID", 400);
  }
  if (commands.reviewGovernance === undefined) {
    return errorResponse("NOT_IMPLEMENTED", "Governance review not supported", 501);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse("VALIDATION", "Invalid JSON body", 400);
  }

  if (typeof body !== "object" || body === null) {
    return errorResponse("VALIDATION", "Request body must be an object", 400);
  }

  const { decision, reason } = body as Record<string, unknown>;
  if (decision !== "approved" && decision !== "rejected") {
    return errorResponse("VALIDATION", "decision must be 'approved' or 'rejected'", 400);
  }

  const result = await commands.reviewGovernance(
    id,
    decision,
    typeof reason === "string" ? reason : undefined,
  );
  return handleCommandResult(result);
}

export async function handlePromoteBrick(
  _req: Request,
  params: RouteParams,
  commands: CommandDispatcher,
): Promise<Response> {
  const id = params.id;
  if (id === undefined) {
    return errorResponse("VALIDATION", "Missing brick ID", 400);
  }
  if (commands.promoteBrick === undefined) {
    return errorResponse("NOT_IMPLEMENTED", "Brick promotion not supported", 501);
  }
  const result = await commands.promoteBrick(id);
  return handleCommandResult(result);
}

export async function handleDemoteBrick(
  _req: Request,
  params: RouteParams,
  commands: CommandDispatcher,
): Promise<Response> {
  const id = params.id;
  if (id === undefined) {
    return errorResponse("VALIDATION", "Missing brick ID", 400);
  }
  if (commands.demoteBrick === undefined) {
    return errorResponse("NOT_IMPLEMENTED", "Brick demotion not supported", 501);
  }
  const result = await commands.demoteBrick(id);
  return handleCommandResult(result);
}

export async function handleQuarantineBrick(
  _req: Request,
  params: RouteParams,
  commands: CommandDispatcher,
): Promise<Response> {
  const id = params.id;
  if (id === undefined) {
    return errorResponse("VALIDATION", "Missing brick ID", 400);
  }
  if (commands.quarantineBrick === undefined) {
    return errorResponse("NOT_IMPLEMENTED", "Brick quarantine not supported", 501);
  }
  const result = await commands.quarantineBrick(id);
  return handleCommandResult(result);
}

// ---------------------------------------------------------------------------
// Task board mutations
// ---------------------------------------------------------------------------

export async function handleAddTask(
  req: Request,
  _params: RouteParams,
  commands: CommandDispatcher,
): Promise<Response> {
  if (commands.addTask === undefined) {
    return errorResponse("NOT_IMPLEMENTED", "Task addition not supported", 501);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse("VALIDATION", "Invalid JSON body", 400);
  }

  if (typeof body !== "object" || body === null) {
    return errorResponse("VALIDATION", "Request body must be an object", 400);
  }

  const { id, description, dependencies, priority } = body as Record<string, unknown>;
  if (typeof id !== "string" || id.trim().length === 0) {
    return errorResponse("VALIDATION", "id is required", 400);
  }
  if (typeof description !== "string" || description.trim().length === 0) {
    return errorResponse("VALIDATION", "description is required", 400);
  }

  const item: TaskItemInput = {
    id: taskItemId(id.trim()),
    description: description.trim(),
    ...(Array.isArray(dependencies)
      ? { dependencies: dependencies.map((d: unknown) => taskItemId(String(d))) }
      : {}),
    ...(typeof priority === "number" ? { priority } : {}),
  };

  const result = await commands.addTask(item);
  return handleCommandResult(result);
}

export async function handleUpdateTask(
  req: Request,
  params: RouteParams,
  commands: CommandDispatcher,
): Promise<Response> {
  const id = params.id;
  if (id === undefined) {
    return errorResponse("VALIDATION", "Missing task ID", 400);
  }
  if (commands.updateTask === undefined) {
    return errorResponse("NOT_IMPLEMENTED", "Task update not supported", 501);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse("VALIDATION", "Invalid JSON body", 400);
  }

  if (typeof body !== "object" || body === null) {
    return errorResponse("VALIDATION", "Request body must be an object", 400);
  }

  const { description, priority } = body as Record<string, unknown>;
  const result = await commands.updateTask(taskItemId(id), {
    ...(typeof description === "string" ? { description } : {}),
    ...(typeof priority === "number" ? { priority } : {}),
  });
  return handleCommandResult(result);
}

export async function handleCancelTask(
  req: Request,
  params: RouteParams,
  commands: CommandDispatcher,
): Promise<Response> {
  const id = params.id;
  if (id === undefined) {
    return errorResponse("VALIDATION", "Missing task ID", 400);
  }
  if (commands.cancelTask === undefined) {
    return errorResponse("NOT_IMPLEMENTED", "Task cancellation not supported", 501);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse("VALIDATION", "Invalid JSON body", 400);
  }

  if (typeof body !== "object" || body === null) {
    return errorResponse("VALIDATION", "Request body must be an object", 400);
  }

  const { reason } = body as Record<string, unknown>;
  if (typeof reason !== "string" || reason.trim().length === 0) {
    return errorResponse("VALIDATION", "reason is required", 400);
  }

  const result = await commands.cancelTask(taskItemId(id), reason.trim());
  return handleCommandResult(result);
}
