import { describe, expect, test } from "bun:test";
import {
  InMemoryConversationAddressStore,
  InMemoryIdempotencyStore,
  InMemoryIngressQueue,
} from "@koi/channel-base";
import type { InboundMessage } from "@koi/core";
import type { TeamsConfig } from "./config.js";
import type { Activity } from "./normalize.js";
import type { FetchFn } from "./platform-send.js";
import { createTeamsChannel, type TeamsDependencies } from "./teams-channel.js";
import type { JwtVerifier, VerifyResult } from "./verify-jwt.js";

const config: TeamsConfig = {
  appId: "app-1",
  appPassword: "secret",
  tenantAllowlist: ["tenant-1"],
  cloud: "public",
  serviceUrlAllowlist: [{ scheme: "https", host: "smba.trafficmanager.net", hostMatch: "exact" }],
  production: false,
  handlerTimeoutMs: 1_000,
  commitTtlMs: 86_400_000,
};

function fakeVerifier(verdict: VerifyResult): JwtVerifier {
  return {
    verify: async () => verdict,
    appToken: async () => "tok",
  };
}

function buildDeps(verifier: JwtVerifier, fetchFn?: FetchFn): TeamsDependencies {
  return {
    tokenVerifier: verifier,
    fetch: fetchFn ?? (async () => new Response("{}", { status: 200 })),
    idempotencyStore: new InMemoryIdempotencyStore(),
    conversationAddressStore: new InMemoryConversationAddressStore(),
    ingressQueue: new InMemoryIngressQueue<Activity, InboundMessage>(),
  };
}

const okVerdict: VerifyResult = {
  ok: true,
  claims: {
    aud: "app-1",
    tid: "tenant-1",
    iss: "https://api.botframework.com",
    exp: 9_999_999_999,
    nbf: 0,
  },
};

function makeActivity(overrides: Partial<Activity> = {}): Activity {
  return {
    type: "message",
    id: "act-1",
    conversation: { id: "conv-1", tenantId: "tenant-1" },
    from: { id: "user-1", name: "Alice" },
    serviceUrl: "https://smba.trafficmanager.net/",
    channelId: "msteams",
    text: "hi",
    timestamp: "2026-05-05T12:00:00.000Z",
    ...overrides,
  };
}

function makeRequest(activity: Activity, auth = "Bearer xxx"): Request {
  return new Request("https://localhost/api/messages", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: auth },
    body: JSON.stringify(activity),
  });
}

describe("createTeamsChannel", () => {
  test("returns ChannelAdapter with handleHttpRequest", () => {
    const ch = createTeamsChannel(config, buildDeps(fakeVerifier(okVerdict)));
    expect(ch.name).toBe("teams");
    expect(typeof ch.handleHttpRequest).toBe("function");
    expect(ch.capabilities.text).toBe(true);
  });

  test("AUDIENCE_MISMATCH path returns 401", async () => {
    const ch = createTeamsChannel(
      config,
      buildDeps(fakeVerifier({ ok: false, code: "AUDIENCE_MISMATCH", message: "x" })),
    );
    const r = await ch.handleHttpRequest(makeRequest(makeActivity()));
    expect(r.status).toBe(401);
  });

  test("SERVICE_URL_NOT_ALLOWED returns 401", async () => {
    const ch = createTeamsChannel(
      config,
      buildDeps(fakeVerifier({ ok: false, code: "SERVICE_URL_NOT_ALLOWED", message: "x" })),
    );
    const r = await ch.handleHttpRequest(makeRequest(makeActivity()));
    expect(r.status).toBe(401);
  });

  test("two same activity.id but different conversation.id BOTH dispatch", async () => {
    const deps = buildDeps(fakeVerifier(okVerdict));
    const ch = createTeamsChannel(config, deps);
    const seen: string[] = [];
    ch.onMessage(async (m) => {
      seen.push(m.threadId ?? "");
    });
    await ch.connect();
    const r1 = await ch.handleHttpRequest(
      makeRequest(
        makeActivity({ id: "shared", conversation: { id: "convA", tenantId: "tenant-1" } }),
      ),
    );
    expect(r1.status).toBe(200);
    const r2 = await ch.handleHttpRequest(
      makeRequest(
        makeActivity({ id: "shared", conversation: { id: "convB", tenantId: "tenant-1" } }),
      ),
    );
    expect(r2.status).toBe(200);
    // give the worker a moment to drain.
    await new Promise((r) => setTimeout(r, 400));
    await ch.disconnect();
    expect(seen.sort()).toEqual(["msteams|tenant-1|convA", "msteams|tenant-1|convB"]);
  });

  test("send() without prior inbound throws CONVERSATION_ADDRESS_UNKNOWN", async () => {
    const ch = createTeamsChannel(config, buildDeps(fakeVerifier(okVerdict)));
    let err: unknown = null;
    try {
      await ch.send({ content: [{ kind: "text", text: "hi" }], threadId: "unknown-conv" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("CONVERSATION_ADDRESS_UNKNOWN");
  });

  test("send() without threadId throws CONVERSATION_ADDRESS_UNKNOWN", async () => {
    const ch = createTeamsChannel(config, buildDeps(fakeVerifier(okVerdict)));
    let err: unknown = null;
    try {
      await ch.send({ content: [{ kind: "text", text: "hi" }] });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("CONVERSATION_ADDRESS_UNKNOWN");
  });

  test("non-message activity (conversationUpdate) returns 200, not 400", async () => {
    // Bot Framework retries on non-2xx; rejecting normal lifecycle
    // events with 400 would loop install/update flows. Authenticated
    // activities of unsupported-but-valid types must be 200-acked.
    const ch = createTeamsChannel(config, buildDeps(fakeVerifier(okVerdict)));
    await ch.connect();
    const update = makeActivity({ type: "conversationUpdate" });
    const res = await ch.handleHttpRequest(makeRequest(update));
    expect(res.status).toBe(200);
    await ch.disconnect();
  });

  test("non-message activity seeds ConversationAddressStore so welcome/proactive sends work", async () => {
    // Regression: previously non-message activities 200-acked without
    // seeding the address store, so bots saw `conversationUpdate` on
    // install but the first welcome reply failed
    // CONVERSATION_ADDRESS_UNKNOWN until the user sent a real message.
    const addressStore = new InMemoryConversationAddressStore();
    const deps: TeamsDependencies = {
      ...buildDeps(fakeVerifier(okVerdict)),
      conversationAddressStore: addressStore,
    };
    const ch = createTeamsChannel(config, deps);
    await ch.connect();
    const update = makeActivity({
      type: "conversationUpdate",
      id: "act-install",
      timestamp: "2026-05-05T11:00:00.000Z",
      serviceUrl: "https://smba.trafficmanager.net/install/",
    });
    await ch.handleHttpRequest(makeRequest(update));
    const stored = await addressStore.get("msteams|tenant-1|conv-1");
    expect(stored).not.toBeNull();
    expect(stored?.serviceUrl).toBe("https://smba.trafficmanager.net/install/");
    await ch.disconnect();
  });

  test("VERIFIER_UNAVAILABLE returns 503 (retryable), not 401", async () => {
    // Regression: a transient JWKS / network failure used to surface
    // as INVALID_JWT → 401. Bot Framework does not retry 401s
    // reliably, dropping valid traffic during a verifier outage.
    const ch = createTeamsChannel(
      config,
      buildDeps(
        fakeVerifier({
          ok: false,
          code: "VERIFIER_UNAVAILABLE",
          message: "fetch failed",
        }),
      ),
    );
    const res = await ch.handleHttpRequest(makeRequest(makeActivity()));
    expect(res.status).toBe(503);
  });

  test("inbound delivered before onMessage handler is installed: NOT silently committed", async () => {
    // Regression: previously the worker treated handlerRef.current === null
    // as success and acked the queue item, returning 200 to Bot
    // Framework while user code never saw the message. Now the
    // dispatcher throws NO_HANDLER so the worker nacks (and on
    // terminal exhaustion dead-letters) — operators see an explicit
    // ingress failure rather than missing inbound traffic.
    const deps = buildDeps(fakeVerifier(okVerdict));
    const ch = createTeamsChannel(config, deps);
    await ch.connect();
    // Note: NO ch.onMessage() registration before sending traffic.
    const res = await ch.handleHttpRequest(makeRequest(makeActivity()));
    expect(res.status).toBe(200);
    // Give the worker a moment to claim the queue item, fail
    // dispatch (NO_HANDLER), and after maxRetries dead-letter it.
    await new Promise((r) => setTimeout(r, 500));
    const dl = await deps.ingressQueue.getDeadLetters();
    expect(dl.length).toBeGreaterThan(0);
    expect(dl[0]?.reason).toContain("NO_HANDLER");
    await ch.disconnect();
  });

  test("handleHttpRequest before connect() returns 503 (worker not running)", async () => {
    // Regression: previously the webhook accepted and 200-acked
    // requests regardless of channel state, including before
    // connect() and after disconnect(). Bot Framework treats 200 as
    // processed, so any traffic landing before/after the worker
    // lifecycle was silent loss. Now the handler fails closed with
    // 503 (retryable) until the worker is live.
    const ch = createTeamsChannel(config, buildDeps(fakeVerifier(okVerdict)));
    const res = await ch.handleHttpRequest(makeRequest(makeActivity()));
    expect(res.status).toBe(503);
  });

  test("handleHttpRequest after disconnect() returns 503", async () => {
    const ch = createTeamsChannel(config, buildDeps(fakeVerifier(okVerdict)));
    await ch.connect();
    await ch.disconnect();
    const res = await ch.handleHttpRequest(makeRequest(makeActivity()));
    expect(res.status).toBe(503);
  });

  test("address store: replay without parseable timestamp does NOT overwrite existing", async () => {
    // Regression: previously the wall-clock fallback let a stale
    // replay missing/invalid `timestamp` clobber a fresh stored
    // serviceUrl/recipient. Now no-timestamp replays only write on
    // first delivery; existing addresses are preserved.
    const addressStore = new InMemoryConversationAddressStore();
    const deps: TeamsDependencies = {
      ...buildDeps(fakeVerifier(okVerdict)),
      conversationAddressStore: addressStore,
    };
    const ch = createTeamsChannel(config, deps);
    await ch.connect();
    // Fresh activity with timestamp lands first.
    const fresh = makeActivity({
      id: "act-fresh",
      timestamp: "2026-05-05T12:00:00.000Z",
      serviceUrl: "https://smba.trafficmanager.net/fresh/",
    });
    await ch.handleHttpRequest(makeRequest(fresh));
    // Stale replay with NO timestamp must not overwrite.
    const stale = makeActivity({
      id: "act-stale",
      serviceUrl: "https://smba.trafficmanager.net/stale/",
    });
    const { timestamp: _drop, ...staleNoTs } = stale;
    void _drop;
    await ch.handleHttpRequest(makeRequest(staleNoTs as Activity));
    const stored = await addressStore.get("msteams|tenant-1|conv-1");
    expect(stored?.serviceUrl).toBe("https://smba.trafficmanager.net/fresh/");
    await ch.disconnect();
  });
});
