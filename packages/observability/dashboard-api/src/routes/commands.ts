/**
 * Command routes — imperative operations (not file-backed).
 *
 * POST /cmd/agents/:id/suspend    — suspend agent
 * POST /cmd/agents/:id/resume     — resume agent
 * POST /cmd/agents/:id/terminate  — terminate agent
 * POST /cmd/events/dlq/:id/retry  — retry dead letter
 * POST /cmd/mailbox/:agentId/list — list agent mailbox
 */

import { agentId } from "@koi/core";
import type { CommandDispatcher } from "@koi/dashboard-types";
import type { RouteParams } from "../router.js";
import { errorResponse, jsonResponse } from "../router.js";

function handleCommandResult(result: {
  readonly ok: boolean;
  readonly error?: { readonly code: string; readonly message: string };
}): Response {
  if (!result.ok && result.error !== undefined) {
    const status = result.error.code === "NOT_FOUND" ? 404 : 500;
    return errorResponse(result.error.code, result.error.message, status);
  }
  return jsonResponse(null);
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
    const status = result.error.code === "NOT_FOUND" ? 404 : 500;
    return errorResponse(result.error.code, result.error.message, status);
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
  const messages = await commands.listMailbox(agentId(aid));
  return jsonResponse(messages);
}
