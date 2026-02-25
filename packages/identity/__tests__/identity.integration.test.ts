/**
 * Integration test: YAML manifest → channel identity → middleware injection.
 */

import { describe, expect, it } from "bun:test";
import type { ModelRequest, ModelResponse, TurnContext } from "@koi/core/middleware";
import { loadManifestFromString } from "@koi/manifest";
import { createIdentityMiddleware } from "../src/identity.js";
import { personasFromManifest } from "../src/manifest.js";

const MOCK_RESPONSE: ModelResponse = {
  content: "Hi",
  model: "test-model",
};

function makeTurnCtx(channelId?: string): TurnContext {
  return {
    session: {
      agentId: "agent-1",
      sessionId: "session:agent:agent-1:abc" as import("@koi/core/ecs").SessionId,
      runId: "run-uuid" as import("@koi/core/ecs").RunId,
      ...(channelId !== undefined ? { channelId } : {}),
      metadata: {},
    },
    turnIndex: 0,
    turnId: "turn-uuid" as import("@koi/core/ecs").TurnId,
    messages: [],
    metadata: {},
  };
}

describe("identity middleware integration", () => {
  it("injects persona system message from YAML manifest channel identity", async () => {
    const yaml = `
name: test-agent
version: 1.0.0
model: anthropic:claude-haiku-4-5-20251001
channels:
  - name: "@koi/channel-telegram"
    identity:
      name: Alex
      instructions: Be casual and friendly.
  - name: "@koi/channel-slack"
    identity:
      name: Research Bot
      instructions: Be formal and concise.
`;

    const result = await loadManifestFromString(yaml);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const manifest = result.value.manifest;
    expect(manifest.channels).toHaveLength(2);

    const telegramChannel = manifest.channels?.[0];
    const slackChannel = manifest.channels?.[1];

    expect(telegramChannel?.identity?.name).toBe("Alex");
    expect(telegramChannel?.identity?.instructions).toBe("Be casual and friendly.");
    expect(slackChannel?.identity?.name).toBe("Research Bot");

    // Build identity middleware directly from manifest using helper
    const mw = await createIdentityMiddleware(personasFromManifest(manifest));
    const { wrapModelCall } = mw;
    expect(wrapModelCall).toBeDefined();
    if (wrapModelCall === undefined) return;

    // Verify Telegram persona injection
    const capturedTelegram: ModelRequest[] = [];
    const nextTelegram = async (req: ModelRequest): Promise<ModelResponse> => {
      capturedTelegram.push(req);
      return MOCK_RESPONSE;
    };

    await wrapModelCall(
      makeTurnCtx("@koi/channel-telegram"),
      {
        messages: [{ senderId: "user", timestamp: 1000, content: [{ kind: "text", text: "Hi" }] }],
      },
      nextTelegram,
    );

    expect(capturedTelegram[0]?.messages).toHaveLength(2);
    const telegramFirst = capturedTelegram[0]?.messages[0];
    expect(telegramFirst?.senderId).toBe("system:identity");
    if (telegramFirst?.content[0]?.kind === "text") {
      expect(telegramFirst.content[0].text).toContain("You are Alex.");
      expect(telegramFirst.content[0].text).toContain("Be casual and friendly.");
    }

    // Verify Slack persona injection
    const capturedSlack: ModelRequest[] = [];
    const nextSlack = async (req: ModelRequest): Promise<ModelResponse> => {
      capturedSlack.push(req);
      return MOCK_RESPONSE;
    };

    await wrapModelCall(
      makeTurnCtx("@koi/channel-slack"),
      {
        messages: [{ senderId: "user", timestamp: 1000, content: [{ kind: "text", text: "Hi" }] }],
      },
      nextSlack,
    );

    const slackFirst = capturedSlack[0]?.messages[0];
    if (slackFirst?.content[0]?.kind === "text") {
      expect(slackFirst.content[0].text).toContain("You are Research Bot.");
      expect(slackFirst.content[0].text).toContain("Be formal and concise.");
    }
  });

  it("no-ops when channel has no identity configured", async () => {
    const yaml = `
name: test-agent
version: 1.0.0
model: anthropic:claude-haiku-4-5-20251001
channels:
  - name: "@koi/channel-cli"
`;

    const result = await loadManifestFromString(yaml);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const manifest = result.value.manifest;
    expect(manifest.channels?.[0]?.identity).toBeUndefined();

    const mw = await createIdentityMiddleware({ personas: [] });
    const { wrapModelCall: wrapCall } = mw;
    expect(wrapCall).toBeDefined();
    if (wrapCall === undefined) return;

    const original: ModelRequest = {
      messages: [{ senderId: "user", timestamp: 1000, content: [{ kind: "text", text: "Hi" }] }],
    };
    let captured: ModelRequest | undefined;
    await wrapCall(makeTurnCtx("@koi/channel-cli"), original, async (req) => {
      captured = req;
      return MOCK_RESPONSE;
    });

    // Same reference — no system message prepended
    expect(captured).toBe(original);
  });
});
