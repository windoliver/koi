import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface TeamMailboxMessage {
  readonly from: string;
  readonly text: string;
  readonly timestamp: string;
  readonly read: boolean;
  readonly color?: string | undefined;
  readonly summary?: string | undefined;
}

export interface TeamMailboxWriteInput {
  readonly from: string;
  readonly text: string;
  readonly timestamp: string;
  readonly color?: string | undefined;
  readonly summary?: string | undefined;
}

export interface FileTeamMailboxConfig {
  readonly rootDir: string;
  readonly teamName: string;
  readonly lockRetries?: number | undefined;
  readonly lockRetryDelayMs?: number | undefined;
}

export interface FileTeamMailbox {
  readonly getInboxPath: (agentName: string) => string;
  readonly read: (agentName: string) => Promise<readonly TeamMailboxMessage[]>;
  readonly readUnread: (agentName: string) => Promise<readonly TeamMailboxMessage[]>;
  readonly write: (agentName: string, message: TeamMailboxWriteInput) => Promise<void>;
  readonly markRead: (
    agentName: string,
    predicate?: (message: TeamMailboxMessage) => boolean,
  ) => Promise<void>;
  readonly clear: (agentName: string) => Promise<void>;
}

export interface PlanApprovalRequestMessage {
  readonly type: "plan_approval_request";
  readonly from: string;
  readonly timestamp: string;
  readonly planFilePath: string | undefined;
  readonly planContent: string;
  readonly requestId: string;
}

export type TeamPermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan";

export interface PlanApprovalResponseMessage {
  readonly type: "plan_approval_response";
  readonly requestId: string;
  readonly approved: boolean;
  readonly timestamp: string;
  readonly feedback?: string | undefined;
  readonly permissionMode?: TeamPermissionMode | undefined;
}

export interface TaskAssignmentMessage {
  readonly type: "task_assignment";
  readonly requestId: string;
  readonly from: string;
  readonly taskId: string;
  readonly assignedTo: string;
  readonly description: string;
  readonly timestamp: string;
}

export interface TaskReportMessage {
  readonly type: "task_report";
  readonly requestId: string;
  readonly from: string;
  readonly taskId: string;
  readonly output: string;
  readonly timestamp: string;
}

export type TeamProtocolMessage =
  | PlanApprovalRequestMessage
  | PlanApprovalResponseMessage
  | TaskAssignmentMessage
  | TaskReportMessage;

function sanitizePathComponent(value: string): string {
  const normalized = value.trim().replaceAll(/[^A-Za-z0-9._-]/g, "_");
  return normalized.length > 0 ? normalized : "default";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withLockFile<T>(
  lockPath: string,
  retries: number,
  retryDelayMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const handle = await open(lockPath, "wx").catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") return undefined;
      throw error;
    });
    if (handle === undefined) {
      if (attempt < retries) {
        await delay(retryDelayMs);
        continue;
      }
      throw new Error(`Failed to acquire mailbox lock at ${lockPath}`);
    }
    try {
      return await fn();
    } finally {
      await handle.close();
      await rm(lockPath, { force: true });
    }
  }
  throw new Error(`Failed to acquire mailbox lock at ${lockPath}`);
}

function isMailboxMessage(value: unknown): value is TeamMailboxMessage {
  if (value === null || typeof value !== "object") return false;
  if (!("from" in value) || !("text" in value) || !("timestamp" in value) || !("read" in value)) {
    return false;
  }
  return (
    typeof value.from === "string" &&
    typeof value.text === "string" &&
    typeof value.timestamp === "string" &&
    typeof value.read === "boolean"
  );
}

function isJsonObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readMessages(path: string): Promise<readonly TeamMailboxMessage[]> {
  try {
    const content = await readFile(path, "utf-8");
    const parsed: unknown = JSON.parse(content);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isMailboxMessage);
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

export function createFileTeamMailbox(config: FileTeamMailboxConfig): FileTeamMailbox {
  const safeTeam = sanitizePathComponent(config.teamName);
  const inboxDir = join(config.rootDir, safeTeam, "inboxes");
  const retries = config.lockRetries ?? 50;
  const retryDelayMs = config.lockRetryDelayMs ?? 5;

  const getInboxPath = (agentName: string): string =>
    join(inboxDir, `${sanitizePathComponent(agentName)}.json`);

  const writeMessages = async (
    path: string,
    messages: readonly TeamMailboxMessage[],
  ): Promise<void> => {
    await mkdir(inboxDir, { recursive: true });
    await writeFile(path, JSON.stringify(messages, null, 2), "utf-8");
  };

  return {
    getInboxPath,
    read: async (agentName) => readMessages(getInboxPath(agentName)),
    readUnread: async (agentName) =>
      (await readMessages(getInboxPath(agentName))).filter((message) => !message.read),
    write: async (agentName, message) => {
      await mkdir(inboxDir, { recursive: true });
      const path = getInboxPath(agentName);
      await withLockFile(`${path}.lock`, retries, retryDelayMs, async () => {
        const messages = await readMessages(path);
        await writeMessages(path, [...messages, { ...message, read: false }]);
      });
    },
    markRead: async (agentName, predicate = () => true) => {
      const path = getInboxPath(agentName);
      await mkdir(inboxDir, { recursive: true });
      await withLockFile(`${path}.lock`, retries, retryDelayMs, async () => {
        const messages = await readMessages(path);
        await writeMessages(
          path,
          messages.map((message) => (predicate(message) ? { ...message, read: true } : message)),
        );
      });
    },
    clear: async (agentName) => {
      const path = getInboxPath(agentName);
      await mkdir(inboxDir, { recursive: true });
      await withLockFile(`${path}.lock`, retries, retryDelayMs, async () => {
        await writeMessages(path, []);
      });
    },
  };
}

export function createPlanApprovalRequestMessage(
  input: Omit<PlanApprovalRequestMessage, "type">,
): PlanApprovalRequestMessage {
  return { ...input, type: "plan_approval_request" };
}

export function createPlanApprovalResponseMessage(
  input: Omit<PlanApprovalResponseMessage, "type">,
): PlanApprovalResponseMessage {
  return { ...input, type: "plan_approval_response" };
}

export function createTaskAssignmentMessage(
  input: Omit<TaskAssignmentMessage, "type">,
): TaskAssignmentMessage {
  return { ...input, type: "task_assignment" };
}

export function createTaskReportMessage(input: Omit<TaskReportMessage, "type">): TaskReportMessage {
  return { ...input, type: "task_report" };
}

function parseJsonObject(text: string): Readonly<Record<string, unknown>> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return isJsonObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function isPlanApprovalRequestMessage(text: string): PlanApprovalRequestMessage | null {
  const parsed = parseJsonObject(text);
  if (
    parsed?.type !== "plan_approval_request" ||
    typeof parsed.from !== "string" ||
    typeof parsed.timestamp !== "string" ||
    typeof parsed.planContent !== "string" ||
    typeof parsed.requestId !== "string"
  ) {
    return null;
  }
  if (parsed.planFilePath !== undefined && typeof parsed.planFilePath !== "string") return null;
  return {
    type: "plan_approval_request",
    from: parsed.from,
    timestamp: parsed.timestamp,
    planFilePath: parsed.planFilePath,
    planContent: parsed.planContent,
    requestId: parsed.requestId,
  };
}

export function isPlanApprovalResponseMessage(text: string): PlanApprovalResponseMessage | null {
  const parsed = parseJsonObject(text);
  if (
    parsed?.type !== "plan_approval_response" ||
    typeof parsed.requestId !== "string" ||
    typeof parsed.approved !== "boolean" ||
    typeof parsed.timestamp !== "string"
  ) {
    return null;
  }
  if (parsed.feedback !== undefined && typeof parsed.feedback !== "string") return null;
  if (
    parsed.permissionMode !== undefined &&
    parsed.permissionMode !== "default" &&
    parsed.permissionMode !== "acceptEdits" &&
    parsed.permissionMode !== "bypassPermissions" &&
    parsed.permissionMode !== "plan"
  ) {
    return null;
  }
  return {
    type: "plan_approval_response",
    requestId: parsed.requestId,
    approved: parsed.approved,
    timestamp: parsed.timestamp,
    ...(parsed.feedback !== undefined ? { feedback: parsed.feedback } : {}),
    ...(parsed.permissionMode !== undefined ? { permissionMode: parsed.permissionMode } : {}),
  };
}

function isTaskAssignmentObject(
  parsed: Readonly<Record<string, unknown>> | undefined,
): TaskAssignmentMessage | null {
  if (
    parsed?.type !== "task_assignment" ||
    typeof parsed.requestId !== "string" ||
    typeof parsed.from !== "string" ||
    typeof parsed.taskId !== "string" ||
    typeof parsed.assignedTo !== "string" ||
    typeof parsed.description !== "string" ||
    typeof parsed.timestamp !== "string"
  ) {
    return null;
  }
  return {
    type: "task_assignment",
    requestId: parsed.requestId,
    from: parsed.from,
    taskId: parsed.taskId,
    assignedTo: parsed.assignedTo,
    description: parsed.description,
    timestamp: parsed.timestamp,
  };
}

function isTaskReportObject(
  parsed: Readonly<Record<string, unknown>> | undefined,
): TaskReportMessage | null {
  if (
    parsed?.type !== "task_report" ||
    typeof parsed.requestId !== "string" ||
    typeof parsed.from !== "string" ||
    typeof parsed.taskId !== "string" ||
    typeof parsed.output !== "string" ||
    typeof parsed.timestamp !== "string"
  ) {
    return null;
  }
  return {
    type: "task_report",
    requestId: parsed.requestId,
    from: parsed.from,
    taskId: parsed.taskId,
    output: parsed.output,
    timestamp: parsed.timestamp,
  };
}

export function parseTeamProtocolMessage(text: string): TeamProtocolMessage | null {
  return (
    isPlanApprovalRequestMessage(text) ??
    isPlanApprovalResponseMessage(text) ??
    isTaskAssignmentObject(parseJsonObject(text)) ??
    isTaskReportObject(parseJsonObject(text))
  );
}
