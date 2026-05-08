import { describe, expect, test } from "bun:test";
import type { ModelRequest, TurnContext } from "@koi/core";
import {
  createMountDescriptionsMiddleware,
  createMountDescriptionsState,
} from "./mount-descriptions-middleware.js";

describe("createMountDescriptionsMiddleware", () => {
  test("places mount blocks after the core prompt and advertised skills", async () => {
    const state = createMountDescriptionsState({
      manifest: [
        { path: "/gdrive/team", connector: "gdrive", description: "Team drive" },
        { path: "/gmail/inbox", connector: "gmail", description: "Email inbox" },
      ],
      runtime: [{ path: "/local/scratch", connector: "local", description: "Scratch space" }],
    });
    const middleware = createMountDescriptionsMiddleware({ state });

    let captured: ModelRequest | undefined;
    await middleware.wrapModelCall?.(
      {} as TurnContext,
      {
        messages: [],
        model: "test-model",
        systemPrompt:
          "<available_skills>\n" +
          '  <skill name="Skill" description="Description" />\n' +
          "</available_skills>\n\n" +
          "base",
      },
      async (request) => {
        captured = request;
        return { content: "", stopReason: "end" };
      },
    );

    expect(captured?.systemPrompt).toBe(
      "base\n\n" +
        "<available_skills>\n" +
        '  <skill name="Skill" description="Description" />\n' +
        "</available_skills>\n\n" +
        "<mounted_connectors>\n" +
        '  <connector path="/gdrive/team" name="gdrive" description="Team drive" />\n' +
        '  <connector path="/gmail/inbox" name="gmail" description="Email inbox" />\n' +
        "</mounted_connectors>\n\n" +
        "<runtime_mounted_connectors>\n" +
        '  <connector path="/local/scratch" name="local" description="Scratch space" />\n' +
        "</runtime_mounted_connectors>",
    );
  });

  test("omits description when it is unavailable", async () => {
    const state = createMountDescriptionsState({
      manifest: [{ path: "/gmail/inbox", connector: "gmail" }],
    });
    const middleware = createMountDescriptionsMiddleware({ state });

    let captured: ModelRequest | undefined;
    await middleware.wrapModelCall?.(
      {} as TurnContext,
      { messages: [], model: "test-model" },
      async (request) => {
        captured = request;
        return { content: "", stopReason: "end" };
      },
    );

    expect(captured?.systemPrompt).toContain('<connector path="/gmail/inbox" name="gmail" />');
    expect(captured?.systemPrompt).not.toContain('description="');
  });

  test("appends mount blocks after the existing prompt when no skills block is present", async () => {
    const state = createMountDescriptionsState({
      runtime: [{ path: "/local/scratch", connector: "local", description: "Scratch space" }],
    });
    const middleware = createMountDescriptionsMiddleware({ state });

    let captured: ModelRequest | undefined;
    await middleware.wrapModelCall?.(
      {} as TurnContext,
      { messages: [], model: "test-model", systemPrompt: "base" },
      async (request) => {
        captured = request;
        return { content: "", stopReason: "end" };
      },
    );

    expect(captured?.systemPrompt).toBe(
      "base\n\n" +
        "<runtime_mounted_connectors>\n" +
        '  <connector path="/local/scratch" name="local" description="Scratch space" />\n' +
        "</runtime_mounted_connectors>",
    );
  });
});
