import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFileTeamMailbox,
  createPlanApprovalRequestMessage,
  createPlanApprovalResponseMessage,
  createTaskAssignmentMessage,
  createTaskReportMessage,
  isPlanApprovalRequestMessage,
  isPlanApprovalResponseMessage,
  parseTeamProtocolMessage,
} from "./mailbox.js";

test("file mailbox preserves concurrent writes with lockfile serialization", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "koi-team-mailbox-"));
  try {
    const mailbox = createFileTeamMailbox({ rootDir, teamName: "alpha/team" });

    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        mailbox.write("worker-a", {
          from: `lead-${String(i)}`,
          text: `message-${String(i)}`,
          timestamp: new Date(i).toISOString(),
        }),
      ),
    );

    const messages = await mailbox.read("worker-a");
    expect(messages).toHaveLength(25);
    expect(new Set(messages.map((message) => message.text)).size).toBe(25);
    expect(messages.every((message) => message.read === false)).toBe(true);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("file mailbox marks messages read and clears inboxes", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "koi-team-mailbox-"));
  try {
    const mailbox = createFileTeamMailbox({ rootDir, teamName: "alpha" });

    await mailbox.write("worker-a", {
      from: "team-lead",
      text: "first",
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    await mailbox.write("worker-a", {
      from: "team-lead",
      text: "second",
      timestamp: "2026-01-01T00:00:01.000Z",
    });

    await mailbox.markRead("worker-a", (message) => message.text === "first");
    expect(await mailbox.readUnread("worker-a")).toEqual([
      {
        from: "team-lead",
        text: "second",
        timestamp: "2026-01-01T00:00:01.000Z",
        read: false,
      },
    ]);

    await mailbox.clear("worker-a");
    expect(await mailbox.read("worker-a")).toEqual([]);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("file mailbox markRead is a no-op for missing inboxes", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "koi-team-mailbox-"));
  try {
    const mailbox = createFileTeamMailbox({ rootDir, teamName: "alpha" });

    await expect(mailbox.markRead("worker-a")).resolves.toBeUndefined();
    expect(await mailbox.read("worker-a")).toEqual([]);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("plan approval protocol messages round-trip through JSON text", () => {
  const request = createPlanApprovalRequestMessage({
    from: "planner",
    planContent: "1. inspect\n2. implement",
    planFilePath: "/tmp/plan.md",
    requestId: "req-1",
    timestamp: "2026-01-01T00:00:00.000Z",
  });
  const response = createPlanApprovalResponseMessage({
    requestId: "req-1",
    approved: true,
    feedback: "ship it",
    permissionMode: "acceptEdits",
    timestamp: "2026-01-01T00:00:01.000Z",
  });

  expect(isPlanApprovalRequestMessage(JSON.stringify(request))).toEqual(request);
  expect(isPlanApprovalResponseMessage(JSON.stringify(response))).toEqual(response);
  expect(isPlanApprovalRequestMessage("{not json")).toBeNull();
  expect(isPlanApprovalResponseMessage(JSON.stringify({ type: "other" }))).toBeNull();
});

test("task assignment and report protocol messages round-trip as typed mailbox payloads", () => {
  const assignment = createTaskAssignmentMessage({
    requestId: "assign-1",
    from: "team-lead",
    taskId: "task-1",
    assignedTo: "coder",
    description: "Implement reporting",
    timestamp: "2026-01-01T00:00:00.000Z",
  });
  const report = createTaskReportMessage({
    requestId: "report-1",
    from: "coder",
    taskId: "task-1",
    output: "reporting complete",
    timestamp: "2026-01-01T00:00:01.000Z",
  });

  expect(parseTeamProtocolMessage(JSON.stringify(assignment))).toEqual(assignment);
  expect(parseTeamProtocolMessage(JSON.stringify(report))).toEqual(report);
  expect(
    parseTeamProtocolMessage(JSON.stringify({ type: "task_assignment", taskId: 7 })),
  ).toBeNull();
});
