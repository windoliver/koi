/**
 * Runtime type guards for task board types.
 */

import type { Task, TaskStatus } from "@koi/core";

const VALID_STATUSES: ReadonlySet<string> = new Set<TaskStatus>([
  "pending",
  "in_progress",
  "completed",
  "failed",
  "killed",
]);

/**
 * Validates that an unknown value has the shape of a Task.
 * Checks required fields, their types, status literals, and
 * that all dependency entries are strings. Rejects malformed
 * records so they cannot crash board logic at runtime.
 */
export function isTask(value: unknown): value is Task {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  // Required fields
  if (
    typeof v.id !== "string" ||
    typeof v.description !== "string" ||
    typeof v.status !== "string" ||
    !VALID_STATUSES.has(v.status) ||
    !Array.isArray(v.dependencies) ||
    !(v.dependencies as readonly unknown[]).every((d) => typeof d === "string") ||
    typeof v.retries !== "number" ||
    typeof v.version !== "number" ||
    typeof v.createdAt !== "number" ||
    typeof v.updatedAt !== "number"
  ) {
    return false;
  }
  // Optional fields: reject if present but wrong type
  if ("subject" in v && typeof v.subject !== "string") return false;
  if ("assignedTo" in v && v.assignedTo !== undefined && typeof v.assignedTo !== "string") {
    return false;
  }
  if ("metadata" in v && v.metadata !== undefined && typeof v.metadata !== "object") return false;
  // startedAt: optional, but if present must be a finite non-negative number.
  // Reject NaN/negative/string so a malformed value can't poison durationMs computations.
  if ("startedAt" in v && v.startedAt !== undefined) {
    if (typeof v.startedAt !== "number" || !Number.isFinite(v.startedAt) || v.startedAt < 0) {
      return false;
    }
  }
  return true;
}
