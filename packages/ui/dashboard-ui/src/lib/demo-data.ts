import type { DashboardSnapshot } from "./state.js";

export const demoDashboardData: DashboardSnapshot = {
  generatedAt: "2026-05-07T22:15:00.000Z",
  agents: [
    {
      id: "agent-orchid",
      name: "Orchid",
      role: "Release steward",
      status: "running",
      region: "us-west-2",
      lastSeenAt: "2026-05-07T22:14:42.000Z",
    },
    {
      id: "agent-lumen",
      name: "Lumen",
      role: "Triage monitor",
      status: "idle",
      region: "us-east-1",
      lastSeenAt: "2026-05-07T22:11:10.000Z",
    },
    {
      id: "agent-sable",
      name: "Sable",
      role: "Nightly verifier",
      status: "error",
      region: "eu-central-1",
      lastSeenAt: "2026-05-07T22:07:02.000Z",
    },
  ],
  sessions: [
    {
      id: "session-orchid-2",
      agentId: "agent-orchid",
      title: "Automation guardrail review",
      summary: "Reviewing heartbeat automation prompts before rollout to the broader agent fleet.",
      status: "active",
      startedAt: "2026-05-07T21:56:00.000Z",
      updatedAt: "2026-05-07T22:14:40.000Z",
      durationMs: 1_120_000,
      metrics: [
        {
          label: "Token usage",
          value: "148K",
          detail: "Across the last 30 minutes",
          trend: "up",
        },
        {
          label: "Tool calls",
          value: "26",
          detail: "Focused on local verification",
          trend: "steady",
        },
        {
          label: "Latency",
          value: "1.2s",
          detail: "Median event turnaround",
          trend: "down",
        },
      ],
      trace: [
        {
          id: "trace-orchid-1",
          label: "Loaded automation templates",
          detail: "Read the active heartbeat defaults and checked prompt constraints.",
          timestamp: "2026-05-07T22:01:12.000Z",
          status: "success",
        },
        {
          id: "trace-orchid-2",
          label: "Compared rollout options",
          detail: "Validated the staged release path against the local demo policy.",
          timestamp: "2026-05-07T22:08:33.000Z",
          status: "running",
        },
        {
          id: "trace-orchid-3",
          label: "Awaiting policy sign-off",
          detail: "Holding the final template update until reviewer confirmation lands.",
          timestamp: "2026-05-07T22:14:40.000Z",
          status: "warning",
        },
      ],
    },
    {
      id: "session-orchid-1",
      agentId: "agent-orchid",
      title: "Dashboard shell smoke pass",
      summary:
        "Exercised the local MVP render path and captured layout notes for the next iteration.",
      status: "completed",
      startedAt: "2026-05-07T18:40:00.000Z",
      updatedAt: "2026-05-07T19:04:00.000Z",
      durationMs: 1_440_000,
      metrics: [
        {
          label: "Visual checks",
          value: "12",
          detail: "Desktop and mobile snapshots",
          trend: "steady",
        },
      ],
      trace: [
        {
          id: "trace-orchid-4",
          label: "Captured layout baseline",
          detail: "Saved the MVP shell screenshots for regression comparisons.",
          timestamp: "2026-05-07T18:58:00.000Z",
          status: "success",
        },
      ],
    },
    {
      id: "session-lumen-1",
      agentId: "agent-lumen",
      title: "Inbox sweep",
      summary: "Collected fresh issue signals and grouped them by workflow bottleneck.",
      status: "queued",
      startedAt: "2026-05-07T21:30:00.000Z",
      updatedAt: "2026-05-07T22:10:03.000Z",
      durationMs: 2_403_000,
      metrics: [
        {
          label: "Unread alerts",
          value: "7",
          detail: "Pending routing decisions",
          trend: "down",
        },
      ],
      trace: [
        {
          id: "trace-lumen-1",
          label: "Prepared routing draft",
          detail: "Waiting for the next poll cycle before dispatching changes.",
          timestamp: "2026-05-07T22:10:03.000Z",
          status: "running",
        },
      ],
    },
    {
      id: "session-sable-1",
      agentId: "agent-sable",
      title: "Nightly verification recovery",
      summary:
        "Investigating a failing typecheck lane after a dependency bump in the sandbox packages.",
      status: "failed",
      startedAt: "2026-05-07T20:12:00.000Z",
      updatedAt: "2026-05-07T22:05:50.000Z",
      durationMs: 6_830_000,
      metrics: [
        {
          label: "Retry count",
          value: "3",
          detail: "Last run still red",
          trend: "up",
        },
        {
          label: "Failure window",
          value: "17m",
          detail: "Since the latest regression surfaced",
          trend: "steady",
        },
      ],
      trace: [
        {
          id: "trace-sable-1",
          label: "Typecheck failed",
          detail: "A package import drifted after the dependency bump.",
          timestamp: "2026-05-07T21:49:20.000Z",
          status: "error",
        },
        {
          id: "trace-sable-2",
          label: "Queued follow-up capture",
          detail: "Extra diagnostics will be attached during the next run.",
          timestamp: "2026-05-07T22:05:50.000Z",
          status: "warning",
        },
      ],
    },
  ],
};
