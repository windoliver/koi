import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import type { EngineEvent } from "@koi/core";
import { renderEvent } from "./render-event.js";

function createStreams() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  stdout.on("data", (c: Buffer) => stdoutChunks.push(c));
  stderr.on("data", (c: Buffer) => stderrChunks.push(c));
  return {
    stdout,
    stderr,
    stdoutText: () => Buffer.concat(stdoutChunks).toString(),
    stderrText: () => Buffer.concat(stderrChunks).toString(),
  };
}

function render(event: EngineEvent, verbose = false) {
  const s = createStreams();
  renderEvent(event, { verbose, stdout: s.stdout, stderr: s.stderr });
  return { stdout: s.stdoutText(), stderr: s.stderrText() };
}

describe("renderEvent", () => {
  describe("text_delta", () => {
    test("writes delta to stdout", () => {
      const { stdout, stderr } = render({ kind: "text_delta", delta: "hello" });
      expect(stdout).toBe("hello");
      expect(stderr).toBe("");
    });
  });

  describe("tool_call_start", () => {
    test("verbose shows tool name on stderr", () => {
      const { stdout, stderr } = render(
        { kind: "tool_call_start", toolName: "web_search", callId: "c1" as never },
        true,
      );
      expect(stdout).toBe("");
      expect(stderr).toContain("[tool]");
      expect(stderr).toContain("web_search");
    });

    test("non-verbose is silent", () => {
      const { stdout, stderr } = render(
        { kind: "tool_call_start", toolName: "web_search", callId: "c1" as never },
        false,
      );
      expect(stdout).toBe("");
      expect(stderr).toBe("");
    });
  });

  describe("tool_call_end", () => {
    test("verbose shows done on stderr", () => {
      const { stderr } = render(
        { kind: "tool_call_end", callId: "c1" as never, result: "ok" },
        true,
      );
      expect(stderr).toContain("[tool]");
      expect(stderr).toContain("done");
    });

    test("non-verbose is silent", () => {
      const { stderr } = render(
        { kind: "tool_call_end", callId: "c1" as never, result: "ok" },
        false,
      );
      expect(stderr).toBe("");
    });
  });

  describe("done", () => {
    const doneEvent: EngineEvent = {
      kind: "done",
      output: {
        content: [],
        stopReason: "completed",
        metrics: {
          totalTokens: 500,
          inputTokens: 300,
          outputTokens: 200,
          turns: 3,
          durationMs: 1234,
        },
      },
    };

    test("writes newline to stdout", () => {
      const { stdout } = render(doneEvent);
      expect(stdout).toBe("\n");
    });

    test("verbose shows metrics on stderr", () => {
      const { stderr } = render(doneEvent, true);
      expect(stderr).toContain("3 turn(s)");
      expect(stderr).toContain("500 tokens");
      expect(stderr).toContain("1234ms");
    });

    test("non-verbose does not show metrics", () => {
      const { stderr } = render(doneEvent, false);
      expect(stderr).toBe("");
    });
  });

  describe("agent_spawned", () => {
    test("shows agent name on stderr", () => {
      const { stderr } = render({
        kind: "agent_spawned",
        agentId: "a1" as never,
        agentName: "researcher",
      });
      expect(stderr).toContain("spawned");
      expect(stderr).toContain("researcher");
    });

    test("shows parent ID when present", () => {
      const { stderr } = render({
        kind: "agent_spawned",
        agentId: "a2" as never,
        agentName: "writer",
        parentAgentId: "a1" as never,
      });
      expect(stderr).toContain("writer");
      expect(stderr).toContain("parent: a1");
    });

    test("no parent info when parentAgentId is undefined", () => {
      const { stderr } = render({
        kind: "agent_spawned",
        agentId: "a1" as never,
        agentName: "main",
      });
      expect(stderr).not.toContain("parent:");
    });
  });

  describe("agent_status_changed", () => {
    test("verbose shows status transition", () => {
      const { stderr } = render(
        {
          kind: "agent_status_changed",
          agentId: "a1" as never,
          agentName: "researcher",
          status: "running",
          previousStatus: "created",
        },
        true,
      );
      expect(stderr).toContain("researcher");
      expect(stderr).toContain("created");
      expect(stderr).toContain("running");
    });

    test("verbose shows status without previous when not provided", () => {
      const { stderr } = render(
        {
          kind: "agent_status_changed",
          agentId: "a1" as never,
          agentName: "researcher",
          status: "running",
        },
        true,
      );
      expect(stderr).toContain("running");
      expect(stderr).not.toContain("undefined");
    });

    test("non-verbose is silent", () => {
      const { stderr } = render(
        {
          kind: "agent_status_changed",
          agentId: "a1" as never,
          agentName: "researcher",
          status: "running",
        },
        false,
      );
      expect(stderr).toBe("");
    });
  });

  describe("silent events", () => {
    const silentEvents: readonly EngineEvent[] = [
      { kind: "turn_start", turnIndex: 0 },
      { kind: "turn_end", turnIndex: 0 },
      { kind: "custom", type: "test", data: {} },
      { kind: "discovery:miss", resolverSource: "test", timestamp: 0 },
      { kind: "spawn_requested", request: {} as never, childAgentId: "c1" as never },
      { kind: "tool_call_delta", callId: "c1" as never, delta: "x" },
    ];

    for (const event of silentEvents) {
      test(`${event.kind} produces no output`, () => {
        const { stdout, stderr } = render(event);
        expect(stdout).toBe("");
        expect(stderr).toBe("");
      });
    }
  });
});
